import type { VectorDB } from "../store/vector-db";
import type { VectorRecord } from "../store/types";
import { escapeSqlString, normalizePath } from "../utils/filter-builder";

export interface GraphNode {
  symbol: string;
  file: string;
  line: number;
  role: string;
  calls: string[];
}

export interface CallGraph {
  center: GraphNode | null;
  callers: GraphNode[];
  callees: string[];
}

export interface TraceOptions {
  depth?: number;
  callersOnly?: boolean;
  calleesOnly?: boolean;
  pathPrefix?: string;
}

export class GraphBuilder {
  constructor(private db: VectorDB) {}

  /**
   * Find all chunks where the symbol is defined.
   * Returns multiple if the same symbol is defined in different files.
   */
  async findDefinitions(symbol: string): Promise<GraphNode[]> {
    const table = await this.db.ensureTable();
    const whereClause = `array_contains(defined_symbols, '${escapeSqlString(symbol)}')`;

    const records = (await table
      .query()
      .where(whereClause)
      .limit(20)
      .toArray()) as VectorRecord[];

    return records.map((r) => this.recordToNode(r, symbol));
  }

  /**
   * Find chunks that reference (call) the given symbol.
   * Excludes chunks that also define the symbol (to avoid self-references).
   */
  async findCallers(symbol: string, limit = 20): Promise<GraphNode[]> {
    const table = await this.db.ensureTable();
    const whereClause = `array_contains(referenced_symbols, '${escapeSqlString(symbol)}')`;

    const records = (await table
      .query()
      .where(whereClause)
      .limit(limit + 20) // Fetch extra to filter self-definitions
      .toArray()) as VectorRecord[];

    // Filter out self-definitions (where this chunk also defines the symbol)
    const filtered = records.filter((r) => {
      const defined = this.toStringArray(r.defined_symbols);
      return !defined.includes(symbol);
    });

    return filtered.slice(0, limit).map((r) => {
      // Find the primary symbol for this chunk (caller)
      const defined = this.toStringArray(r.defined_symbols);
      const callerSymbol = defined[0] || r.parent_symbol || "(anonymous)";
      return this.recordToNode(r, callerSymbol);
    });
  }

  /**
   * Given a list of symbol names, return only those that have definitions
   * in the index (i.e., internal to the project, not external libraries).
   */
  async filterToInternal(symbols: string[]): Promise<string[]> {
    if (symbols.length === 0) return [];

    const table = await this.db.ensureTable();
    const internal: string[] = [];

    // Batch check which symbols have definitions
    // For efficiency, we use a single query with OR conditions
    // But LanceDB doesn't support OR in array_contains well, so we check individually
    // This is acceptable since callees are typically <20 per function
    for (const sym of symbols) {
      const whereClause = `array_contains(defined_symbols, '${escapeSqlString(sym)}')`;
      const records = await table.query().where(whereClause).limit(1).toArray();
      if (records.length > 0) {
        internal.push(sym);
      }
    }

    return internal;
  }

  /**
   * Build the call graph for a symbol.
   * Returns the definition (center), callers, and callees (filtered to internal).
   */
  async buildGraph(
    symbol: string,
    options?: TraceOptions,
  ): Promise<CallGraph> {
    const { callersOnly, calleesOnly, pathPrefix } = options || {};

    // Find definitions
    let definitions = await this.findDefinitions(symbol);

    // Apply path prefix filter if specified
    if (pathPrefix) {
      const normalizedPrefix = normalizePath(pathPrefix);
      definitions = definitions.filter((d) =>
        d.file.startsWith(normalizedPrefix),
      );
    }

    // For now, take the first definition as center (could show all)
    const center = definitions[0] || null;

    // Get callers if not callees-only
    let callers: GraphNode[] = [];
    if (!calleesOnly) {
      callers = await this.findCallers(symbol);
      if (pathPrefix) {
        const normalizedPrefix = normalizePath(pathPrefix);
        callers = callers.filter((c) => c.file.startsWith(normalizedPrefix));
      }
    }

    // Get callees if not callers-only
    let callees: string[] = [];
    if (!callersOnly && center) {
      // Get the raw referenced_symbols from the center definition
      const rawCallees = center.calls;
      // Filter to only internal symbols (have definitions in index)
      callees = await this.filterToInternal(rawCallees);
    }

    return { center, callers, callees };
  }

  private recordToNode(record: VectorRecord, symbol: string): GraphNode {
    return {
      symbol,
      file: record.path,
      line: record.start_line,
      role: record.role || "IMPL",
      calls: this.toStringArray(record.referenced_symbols),
    };
  }

  private toStringArray(val: unknown): string[] {
    if (!val) return [];
    if (Array.isArray(val)) {
      return val.filter((v) => typeof v === "string");
    }
    if (typeof (val as any).toArray === "function") {
      try {
        const arr = (val as any).toArray();
        if (Array.isArray(arr)) return arr.filter((v) => typeof v === "string");
        return Array.from(arr || []).filter(
          (v) => typeof v === "string",
        ) as string[];
      } catch {
        return [];
      }
    }
    return [];
  }
}
