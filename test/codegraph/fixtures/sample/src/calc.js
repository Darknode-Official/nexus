import { add, double } from "./math.js";
import { log } from "../lib/logger.js";
export class Calculator {
  constructor() { this.total = 0; }
  addTo(n) { this.total = add(this.total, n); log(this.total); return this.total; }
  scale() { return double(this.total); }
}
