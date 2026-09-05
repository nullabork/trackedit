import type { GridCoord } from "./math";

/** One placeable thing. `kind` distinguishes grid blocks from free-anchored items. */
export interface BlockDef {
  readonly name: string;
  readonly label: string;
  readonly category: string;
  readonly kind: "block" | "item";
  /** Popularity across the corpus the catalog was built from; drives default sort. */
  readonly uses: number;
  /**
   * Footprint in grid cells. Unknown until real BlockInfo metadata is
   * extracted from the game files; renderers fall back to 1x1x1.
   */
  readonly size?: GridCoord;
  readonly author?: string;
}

export interface CatalogJson {
  source?: string;
  blocks: Array<{ name: string; label: string; category: string; uses: number }>;
  items: Array<{ name: string; label: string; author?: string; uses: number }>;
}

export class BlockCatalog {
  private byName = new Map<string, BlockDef>();
  readonly defs: BlockDef[];
  readonly categories: string[];

  constructor(defs: BlockDef[]) {
    this.defs = defs;
    for (const d of defs) this.byName.set(d.name, d);
    this.categories = [...new Set(defs.map((d) => d.category))].sort();
  }

  static fromJson(json: CatalogJson): BlockCatalog {
    const defs: BlockDef[] = [
      ...json.blocks.map((b): BlockDef => ({ ...b, kind: "block" })),
      ...json.items.map(
        (i): BlockDef => ({ ...i, category: "Items", kind: "item" }),
      ),
    ];
    return new BlockCatalog(defs);
  }

  get(name: string): BlockDef | undefined {
    return this.byName.get(name);
  }

  /** Merge real grid footprints (extracted from the game files) into the defs. */
  applySizes(sizes: ReadonlyMap<string, GridCoord>): void {
    for (const [name, size] of sizes) {
      const def = this.byName.get(name);
      if (def) (def as { size?: GridCoord }).size = size;
    }
  }

  /** Case-insensitive substring search over name/label, optional category filter. */
  search(query: string, category?: string): BlockDef[] {
    const q = query.trim().toLowerCase();
    return this.defs.filter((d) => {
      if (category && d.category !== category) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.label.toLowerCase().includes(q);
    });
  }
}
