string Instance;
string LastStatus = "Starting";
string LastCommandStatus;
CMwNod@ LastMap;
uint MapEpoch = 0;

void Main() {
    Instance = tostring(Time::Now) + "-" + tostring(Math::Rand(0, 1000000000));
    if (BridgeToken.Length == 0) {
        LastStatus = "Install / pair this plugin from trackedit's Live editor dialog.";
        return;
    }
    Meta::StartWithRunContext(Meta::RunContext::GameLoop, PollLoop);
}

void RenderMenu() {
    if (UI::MenuItem("Trackedit Live: " + LastStatus)) {}
}

Json::Value@ Post(const string &in path, Json::Value@ body) {
    auto req = Net::HttpRequest();
    req.Method = Net::HttpMethod::Post;
    req.Url = BridgeUrl + path;
    req.Headers["Content-Type"] = "application/json";
    req.Headers["X-Trackedit-Token"] = BridgeToken;
    req.Body = Json::Write(body);
    req.Start();
    uint started = Time::Now;
    while (!req.Finished()) {
        if (Time::Now - started > 5000) throw("Local bridge request timed out");
        yield();
    }
    if (req.ResponseCode() != 200) throw("Local bridge HTTP " + req.ResponseCode() + ". Re-pair after restarting the dev server.");
    return Json::Parse(req.String());
}

// Epoch changes across editor/map transitions, including leaving and reopening a map.
string MapSession() {
    auto editor = cast<CGameCtnEditorFree>(GetApp().Editor);
    CMwNod@ map;
    if (editor !is null) @map = editor.Challenge;
    if (map !is LastMap) {
        @LastMap = map;
        MapEpoch++;
    }
    return map is null ? "" : Instance + "-" + tostring(MapEpoch);
}

void Update(float dt) {
    MapSession();
}

string ReadinessError() {
    auto app = GetApp();
    auto editor = cast<CGameCtnEditorFree>(app.Editor);
    if (editor is null || editor.Challenge is null || editor.PluginMapType is null)
        return "Open a map in the game's main map editor.";
    if (app.LoadProgress.State != NGameLoadProgress::EState::Disabled)
        return "The game is still loading. Wait for loading to finish.";
    if (app.CurrentPlayground !is null)
        return "The game has an active driving/test session. Return to the map editor.";
    if (!editor.PluginMapType.IsEditorReadyForRequest)
        return "The game editor is not accepting edit requests. Close any in-game editor dialog or operation.";
    return "";
}

bool Ready() {
    return ReadinessError().Length == 0;
}

Json::Value@ Status() {
    auto o = Json::Object();
    o["instance"] = Instance;
    o["protocol"] = 2;
    o["mapSession"] = MapSession();
    string reason = ReadinessError();
    o["ready"] = reason.Length == 0;
    o["error"] = reason;
    o["inEditor"] = LastMap !is null;
    return o;
}

void PollLoop() {
    while (true) {
        try {
            auto status = Status();
            if (Watching && Ready()) status["snapshot"] = CaptureSnapshot();
            auto response = Post("/poll", status);
            Watching = response.HasKey("watching") && bool(response["watching"]);
            LastStatus = LastCommandStatus.Length > 0 ? LastCommandStatus : "Connected to trackedit";
            if (response.HasKey("command") && response["command"].GetType() == Json::Type::Object) {
                auto cmd = response["command"];
                Json::Value@ result = Json::Object();
                result["id"] = cmd["id"];
                try {
                    if (string(cmd["instance"]) != Instance) throw("Game bridge session changed");
                    if (string(cmd["action"]) == "sync") {
                        @result = ApplySync(cmd);
                        result["id"] = cmd["id"];
                        LastStatus = "Synchronizing blocks";
                    } else {
                        string message = Execute(cmd);
                        result["ok"] = true;
                        result["message"] = message;
                        LastStatus = message;
                    }
                } catch {
                    result["ok"] = false;
                    result["error"] = getExceptionInfo();
                    LastStatus = getExceptionInfo();
                    warn("Live command failed: " + LastStatus);
                }
                LastCommandStatus = LastStatus;
                // Retry the RESULT only. Never repeat a game command on network failure.
                for (uint attempt = 0; attempt < 3; attempt++) {
                    try { Post("/result", result); break; }
                    catch { LastStatus = getExceptionInfo(); sleep(500); }
                }
            }
        } catch { LastStatus = getExceptionInfo(); }
        sleep(500);
    }
}

uint CountMatchingBlocks(CGameCtnEditorFree@ editor, const string &in name, const nat3 &in coord, int dir) {
    uint count = 0;
    auto pmt = editor.PluginMapType;
    for (uint i = 0; i < pmt.ClassicBlocks.Length; i++) {
        auto b = pmt.ClassicBlocks[i];
        if (b.BlockInfo is null || b.BlockInfo.IdName != name) continue;
        if (b.Coord.x == coord.x && b.Coord.y == coord.y && b.Coord.z == coord.z && int(b.Direction) == dir) count++;
    }
    return count;
}

string Execute(Json::Value@ cmd) {
    auto p = cmd["payload"];
    if (string(cmd["action"]) != "place") throw("Unknown game command");
    string reason = ReadinessError();
    if (reason.Length > 0) throw(reason);
    if (MapSession() != string(cmd["mapSession"])) throw("Game map changed; block was not placed.");
    auto editor = cast<CGameCtnEditorFree>(GetApp().Editor);
    auto pmt = editor.PluginMapType;
    auto model = pmt.GetBlockModelFromName(string(p["name"]));
    if (model is null) throw("Block model is not available in the game: " + string(p["name"]));
    nat3 coord = nat3(uint(p["coord"][0]), uint(p["coord"][1]), uint(p["coord"][2]));
    // Editor++'s macroblock factory clamps its internal Y subtraction at zero.
    // A requested Y=0 therefore cannot round-trip through this placement path.
    if (coord.y == 0) throw("Grid Y=0 is unsupported by this placement path. Place a new block at level 8 or higher for a normal Stadium map.");
    auto size = editor.Challenge.Size;
    if (coord.x >= size.x || coord.y >= size.y || coord.z >= size.z) throw("Block cell is outside the game map.");
    // Factory expects game grid coordinates and performs the internal macroblock Y correction.
    auto block = Editor::MakeBlockSpec(model, coord, int(p["dir"]));
    block.isGround = bool(p["isGround"]);
    block.isGhost = false;
    block.isFree = false;
    auto mb = Editor::MakeMacroblockSpec();
    mb.Blocks.InsertLast(block);
    uint before = CountMatchingBlocks(editor, string(p["name"]), coord, int(p["dir"]));
    string location = "[" + coord.x + ", " + coord.y + ", " + coord.z + "]";
    trace("Placing " + string(p["name"]) + " at grid " + location);
    // Keep this placement undoable in the standalone game editor.
    if (!Editor::PlaceMacroblock(mb, true)) throw("The game rejected the block placement.");
    if (CountMatchingBlocks(editor, string(p["name"]), coord, int(p["dir"])) <= before) {
        throw("Placement API returned success, but no additional matching block was found at " + location + ". Check the game before sending again.");
    }
    return "Verified " + string(p["name"]) + " at game grid " + location
        + (coord.y < 8 ? ". This height is below the normal Stadium surface." : ".");
}
