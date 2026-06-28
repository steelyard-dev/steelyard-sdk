import type { RailName } from "../types.js";
import type { PolicyRailAdapter } from "./adapter.js";

export class RailRegistry {
  private readonly byName = new Map<RailName, PolicyRailAdapter>();

  register(adapter: PolicyRailAdapter): void {
    if (this.byName.has(adapter.name)) throw new Error(`rail ${adapter.name} already registered`);
    this.byName.set(adapter.name, adapter);
  }

  get(name: RailName): PolicyRailAdapter {
    const adapter = this.byName.get(name);
    if (!adapter) throw new Error(`rail not registered: ${name}`);
    return adapter;
  }

  list(): PolicyRailAdapter[] {
    return [...this.byName.values()];
  }
}
