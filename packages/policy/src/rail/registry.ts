import type { RailName } from "../types.js";
import type { RailAdapter } from "./adapter.js";

export class RailRegistry {
  private readonly byName = new Map<RailName, RailAdapter>();

  register(adapter: RailAdapter): void {
    if (this.byName.has(adapter.name)) throw new Error(`rail ${adapter.name} already registered`);
    this.byName.set(adapter.name, adapter);
  }

  get(name: RailName): RailAdapter {
    const adapter = this.byName.get(name);
    if (!adapter) throw new Error(`rail not registered: ${name}`);
    return adapter;
  }

  list(): RailAdapter[] {
    return [...this.byName.values()];
  }
}
