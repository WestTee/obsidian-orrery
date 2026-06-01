import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

/*
 * Orrery  -  "galaxy" layout for Obsidian's graph view
 * ------------------------------------------------------------------
 * Turns the graph into a galaxy that auto-adapts to ANY vault:
 *   - black hole:  the most-connected note is pinned at the centre; everything
 *                  orbits it. (No config -- it's whatever your busiest hub is.)
 *   - disk:        every other linked note clusters by the folder it lives in
 *                  (its immediate parent). Folders are auto-discovered and
 *                  placed around a ring; related folders sit adjacent.
 *   - Oort cloud:  notes with NO links scatter in a slow outer halo, detached;
 *                  a tunable fraction take elongated "comet" orbits that dive in
 *                  toward the black hole (Kepler ellipse, focus at the centre).
 *   - spin:        the whole disk rotates RIGIDLY as one (clusters keep their
 *                  spacing); only the detached Oort cloud drifts at its own rate.
 *
 * Grouping is driven purely by FOLDER STRUCTURE, never by Obsidian's colour
 * groups (those are independent and only affect colour). An optional override
 * box lets power users force specific groupings/order.
 *
 * Why it doesn't jitter:
 *   Obsidian runs the graph force-sim in a Web Worker; the only lever is pinning
 *   nodes via worker.postMessage({forceNode, alpha, run}). Because WE compute
 *   every target and ease nodes toward it, motion is deterministic and smooth.
 *   When motion is off, once movement falls below a threshold we STOP posting so
 *   the worker cools and the layout holds perfectly still.
 *
 * Touches undocumented Obsidian internals (leaf.view.renderer + graph worker)
 * and may break on an Obsidian update. Only affects graph rendering -- your
 * notes are never read or modified. Disable the plugin to revert instantly.
 */

interface ClusterSettings {
	enabled: boolean;
	motion: boolean;
	/** Ring angular velocity in rad/s (halo derived from this). */
	rotationSpeed: number;
	/** Moon orbital pace around its planet, as a multiplier on rotation speed. */
	moonSpeed: number;
	/** Lerp fraction toward target per cycle; how hard groups hold their zone. */
	strength: number;
	/** Ring radius multiplier (relative to the graph's natural spread). */
	spread: number;
	/** Internal-spread scale: 1 = preserve folder layout, <1 = tighter clump. */
	tightness: number;
	/** Update interval (ms) when NOT spinning. */
	intervalMs: number;
	/** Simulation energy injected while applying positions. */
	reheat: number;
	/** Fraction (0..1) of Oort-cloud notes that take elongated "comet" orbits. */
	cometFraction: number;
	/** Comet orbital pace, as a multiplier on rotation speed. */
	cometSpeed: number;
	/** Comet aphelion -- how far OUT comets swing, as a factor of ring radius R. */
	cometReach: number;
	/** Comet perihelion -- how CLOSE comets dive to the black hole (factor of R). */
	cometDive: number;
	/** Auto-fit the whole galaxy into view the first time a graph opens. */
	fitOnLoad: boolean;
	/**
	 * OPTIONAL manual override. Empty = fully automatic folder-based grouping.
	 * If non-empty: these path prefixes define the groups AND their ring order
	 * (longest match wins). For power users / forcing a specific split.
	 */
	overrideGroups: string[];
}

const DEFAULT_SETTINGS: ClusterSettings = {
	enabled: true,
	motion: true,
	rotationSpeed: 0.1, // slow ambient drift
	moonSpeed: 4.5, // moons orbit their planet faster than the disk turns
	strength: 0.25,
	spread: 1.2,
	tightness: 1.0,
	intervalMs: 120,
	reheat: 0.3,
	cometFraction: 0.4,
	cometSpeed: 5,
	cometReach: 2.3,
	cometDive: 0.4,
	fitOnLoad: true,
	overrideGroups: [],
};

const OMEGA_HALO = 1.6; // Oort cloud drifts at its own rate (it's detached anyway)
const GOLDEN_ANGLE = 2.399963229728653; // even halo scatter
const MOTION_INTERVAL_MS = 33; // ~30fps while spinning

/*
 * The whole disk (hub + planets + moons) rotates RIGIDLY at one rate, so every
 * node keeps its position relative to the others and clusters never drift across
 * each other. Only the detached Oort cloud spins at a different rate (OMEGA_HALO).
 */

/* ---- Minimal shapes for Obsidian's undocumented graph internals ---- */
interface GraphNode {
	id: string;
	x: number;
	y: number;
	fx: number | null;
	fy: number | null;
	weight?: number;
	forward?: Record<string, unknown>;
	reverse?: Record<string, unknown>;
}
interface GraphLink {
	source?: GraphNode;
	target?: GraphNode;
}
interface GraphRenderer {
	nodes: GraphNode[];
	links?: GraphLink[];
	worker: Worker;
	dragNode: GraphNode | null;
	changed(): void;
}

type NodeKind = "anchor" | "orphan" | "hub" | "group";
interface Classification {
	kind: NodeKind;
	group?: string;
	/** group members only: the most-connected member is the planet (centre). */
	planet?: boolean;
	/** moon ordinal within its cluster (1..moonCount); planet has none. */
	moonIndex?: number;
	moonCount?: number;
}
interface RendererState {
	baseline: number;
	nodeCount: number;
	/** Fixed galaxy centre, captured once -- never recomputed (avoids drift). */
	center: { x: number; y: number };
	anchorId: string | null;
	/** per-group orbital geometry: radius factor (x R) + angular jitter. */
	groupGeom: Map<string, { radius: number; jitter: number }>;
	/** group keys in ring-slot order */
	groupOrder: string[];
	/** orphan id -> stable halo index */
	orphanIndex: Map<string, number>;
	classification: Map<string, Classification>;
	pinned: Set<string>;
}

export default class GraphFolderClusterPlugin extends Plugin {
	settings!: ClusterSettings;

	private rafId: number | null = null;
	private lastTick = 0;
	private phase = 0; // elapsed spin time (s); advances only while moving
	private states = new WeakMap<GraphRenderer, RendererState>();
	/** renderers already auto-fitted to view (so we only do it on first open). */
	private fitted = new WeakSet<GraphRenderer>();
	/** Natural scale captured ONCE per graph, so spread/tuning is predictable. */
	private scales = new WeakMap<
		GraphRenderer,
		{ baseline: number; center: { x: number; y: number }; nodeCount: number }
	>();

	/** override prefixes, longest-first (for matching) and in display order */
	private overrideMatch: string[] = [];
	private overrideOrder: string[] = [];

	async onload() {
		await this.loadSettings();
		this.recomputeOverride();
		this.addSettingTab(new ClusterSettingTab(this.app, this));

		this.addCommand({
			id: "toggle-folder-clustering",
			name: "Toggle folder clustering",
			callback: () => {
				this.settings.enabled = !this.settings.enabled;
				void this.saveSettings();
				if (!this.settings.enabled) this.releaseAll();
				new Notice(
					`Graph folder clustering ${this.settings.enabled ? "on" : "off"}`
				);
			},
		});
		this.addCommand({
			id: "toggle-galaxy-motion",
			name: "Toggle galaxy motion (spin)",
			callback: () => {
				this.settings.motion = !this.settings.motion;
				void this.saveSettings();
				new Notice(
					`Galaxy motion ${this.settings.motion ? "on" : "off"}`
				);
			},
		});
		this.addCommand({
			id: "recenter-clusters",
			name: "Re-center / re-animate clusters",
			callback: () => {
				this.scales = new WeakMap(); // re-measure natural scale
				this.fitted = new WeakSet(); // refit on the next frame
				this.reengage();
			},
		});
		this.addCommand({
			id: "fit-galaxy",
			name: "Fit galaxy to view",
			callback: () => {
				for (const renderer of this.getRenderers()) {
					const state = this.states.get(renderer);
					if (state) this.fitToView(renderer, state);
				}
			},
		});
		this.addCommand({
			id: "log-galaxy-diagnostics",
			name: "Log galaxy diagnostics (to console)",
			callback: () => this.logDiagnostics(),
		});

		this.app.workspace.onLayoutReady(() => this.startLoop());
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.startLoop())
		);
	}

	onunload() {
		this.stopLoop();
		this.releaseAll();
	}

	/* ---------------- settings ---------------- */

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.recomputeOverride();
		this.releaseAll(); // free pins (esp. hubs when motion turns off)
		this.reengage();
	}

	recomputeOverride() {
		const cleaned = (this.settings.overrideGroups || [])
			.map((s) => s.trim().replace(/\/+$/, ""))
			.filter((s) => s.length > 0);
		this.overrideOrder = cleaned;
		this.overrideMatch = [...cleaned].sort((a, b) => b.length - a.length);
	}

	private reengage() {
		this.phase = 0;
		this.states = new WeakMap();
	}

	/* ---------------- render loop ---------------- */

	private startLoop() {
		if (this.rafId != null) return;
		const tick = () => {
			this.rafId = requestAnimationFrame(tick);
			try {
				this.maybeUpdate();
			} catch (e) {
				console.error("[orrery] update failed", e);
			}
		};
		this.rafId = requestAnimationFrame(tick);
	}

	private stopLoop() {
		if (this.rafId != null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	/* ---------------- main cycle ---------------- */

	private maybeUpdate() {
		if (!this.settings.enabled || this.settings.strength <= 0) return;

		const moving = this.settings.motion;
		const interval = moving ? MOTION_INTERVAL_MS : this.settings.intervalMs;

		const now = performance.now();
		const dt = this.lastTick ? (now - this.lastTick) / 1000 : 0;
		if (now - this.lastTick < interval) return;
		this.lastTick = now;

		const clampedDt = Math.min(Math.max(dt, 0), 0.25);
		if (moving) this.phase += clampedDt;

		for (const renderer of this.getRenderers()) {
			this.updateRenderer(renderer, moving, clampedDt);
		}
	}

	private updateRenderer(
		renderer: GraphRenderer,
		moving: boolean,
		dt: number
	) {
		const nodes = renderer.nodes;
		if (!nodes || nodes.length === 0) return;
		const finite = nodes.filter(
			(n) => Number.isFinite(n.x) && Number.isFinite(n.y)
		);
		if (finite.length === 0) return;

		let state = this.states.get(renderer);
		if (!state || state.nodeCount !== nodes.length) {
			state = this.buildState(renderer, finite);
			this.states.set(renderer, state);
		}

		if (this.settings.fitOnLoad && !this.fitted.has(renderer)) {
			this.fitToView(renderer, state);
			this.fitted.add(renderer);
		}

		// Fixed centre -- captured once, so pushing nodes out can't drift it.
		const cx = state.center.x;
		const cy = state.center.y;
		const R = state.baseline * this.settings.spread;
		const speed = this.settings.rotationSpeed;
		const numGroups = state.groupOrder.length || 1;
		const tight = this.settings.tightness;
		const slotAngle = (2 * Math.PI) / numGroups;

		// folder zone centres. Base angle uses the GOLDEN ANGLE (not sequential
		// slots) so planets that are contiguous in the affinity order -- and the
		// slow outer ones that barely rotate -- are scattered evenly around the
		// black hole instead of clumping on one side.
		const order = state.groupOrder;
		const zones: Record<string, { x: number; y: number; r: number }> = {};
		for (let i = 0; i < order.length; i++) {
			const geom = state.groupGeom.get(order[i]);
			const rFactor = geom?.radius ?? 1;
			const jitter = (geom?.jitter ?? 0) * slotAngle * 0.35;
			// One rigid rate for the whole disk -> clusters keep their spacing
			// and never drift across one another.
			const angle = i * GOLDEN_ANGLE + jitter + this.phase * speed;
			const zr = R * rFactor;
			zones[order[i]] = {
				x: cx + zr * Math.cos(angle),
				y: cy + zr * Math.sin(angle),
				r: zr,
			};
		}

		const s = this.settings.strength;
		const eps = Math.max(0.5, R * 0.002);
		const hubDAng = speed * dt; // hubs rotate rigidly with the disk
		const hubCos = Math.cos(hubDAng);
		const hubSin = Math.sin(hubDAng);
		let maxMoved = 0;
		const updates: { node: GraphNode; x: number; y: number }[] = [];

		for (const n of finite) {
			if (n === renderer.dragNode) continue;
			const c = state.classification.get(n.id);
			if (!c) continue;

			let tx: number;
			let ty: number;

			if (c.kind === "anchor") {
				tx = cx; // black hole: dead centre, no rotation
				ty = cy;
			} else if (c.kind === "group" && c.group) {
				const zone = zones[c.group];
				if (!zone) continue;
				if (c.planet) {
					tx = zone.x; // planet: cluster centre
					ty = zone.y;
				} else {
					// moon: rotating disc around the planet, sized to the arc
					// room at this planet's orbit, with a clear inner gap so
					// moons don't sit on top of their planet.
					const i = c.moonIndex ?? 1;
					const m = c.moonCount ?? 1;
					const arc = zone.r * slotAngle; // room at this orbit
					const moonR = Math.min(arc * 0.42, R * 0.5) * tight;
					const rr = moonR * (0.5 + 0.5 * Math.sqrt(i / m));
					// Moons orbit their planet (faster than the disk turns). The
					// planet RING itself stays rigid, so clusters never drift
					// across each other -- only the moons circle, locally.
					const theta =
						i * GOLDEN_ANGLE +
						this.phase * speed * this.settings.moonSpeed;
					tx = zone.x + rr * Math.cos(theta);
					ty = zone.y + rr * Math.sin(theta);
				}
			} else if (c.kind === "orphan") {
				const i = state.orphanIndex.get(n.id) ?? 0;
				const apo = R * (2.1 + 0.5 * ((i * 0.6180339887) % 1));
				const h = this.hash(n.id);
				const isComet =
					this.settings.cometFraction > 0 &&
					(h % 1000) / 1000 < this.settings.cometFraction;
				if (isComet) {
					// Real comet motion: an ellipse with the black hole at a
					// FOCUS, timed by Kepler's 2nd law -- it drifts slowly at the
					// far point (aphelion = "reach"), then whips fast around the
					// black hole at its close approach (perihelion = "dive"). Both
					// are user-tunable (x R); small per-comet variety from the hash.
					const reach =
						R *
						this.settings.cometReach *
						(0.85 + 0.3 * ((h % 97) / 97));
					let dive =
						R *
						this.settings.cometDive *
						(0.7 + 0.6 * (((h >> 3) % 97) / 97));
					if (dive > reach * 0.9) dive = reach * 0.9; // keep an ellipse
					const a = (reach + dive) / 2;
					const ecc = (reach - dive) / (reach + dive);
					const periDir = ((h * 0.6180339887) % 1) * 2 * Math.PI;
					const M =
						i * GOLDEN_ANGLE +
						this.phase * speed * this.settings.cometSpeed;
					let E = M; // solve Kepler's equation  M = E - e*sin(E)
					for (let k = 0; k < 6; k++) {
						E =
							E -
							(E - ecc * Math.sin(E) - M) /
								(1 - ecc * Math.cos(E));
					}
					const nu =
						2 *
						Math.atan2(
							Math.sqrt(1 + ecc) * Math.sin(E / 2),
							Math.sqrt(1 - ecc) * Math.cos(E / 2)
						);
					const r = a * (1 - ecc * Math.cos(E));
					const ang = periDir + nu;
					tx = cx + r * Math.cos(ang);
					ty = cy + r * Math.sin(ang);
				} else {
					const angle =
						i * GOLDEN_ANGLE + this.phase * speed * OMEGA_HALO;
					tx = cx + apo * Math.cos(angle);
					ty = cy + apo * Math.sin(angle);
				}
			} else {
				// hub: free in centre when still; pinned & spun when moving
				if (!moving) {
					if (state.pinned.has(n.id)) this.unpin(renderer, n, state);
					continue;
				}
				const rx = n.x - cx;
				const ry = n.y - cy;
				tx = cx + (rx * hubCos - ry * hubSin);
				ty = cy + (rx * hubSin + ry * hubCos);
			}

			const nx = n.x + s * (tx - n.x);
			const ny = n.y + s * (ty - n.y);
			maxMoved = Math.max(maxMoved, Math.hypot(nx - n.x, ny - n.y));
			updates.push({ node: n, x: nx, y: ny });
		}

		// Still + converged -> stop posting so the worker cools (no jitter).
		if (!moving && maxMoved < eps) return;

		for (const u of updates) {
			u.node.fx = u.x;
			u.node.fy = u.y;
			try {
				renderer.worker.postMessage({
					forceNode: { id: u.node.id, x: u.x, y: u.y },
					alpha: this.settings.reheat,
					alphaTarget: 0,
					run: true,
				});
			} catch {
				/* worker may be gone */
			}
			state.pinned.add(u.node.id);
		}
		renderer.changed();
	}

	/* ---------------- classification / ordering ---------------- */

	private buildState(
		renderer: GraphRenderer,
		finite: GraphNode[]
	): RendererState {
		// Natural centre + scale: captured ONCE per graph and never recomputed.
		// Re-measuring is a feedback loop: a settings change unpins nodes (native
		// physics pushes them outward), and measuring the spread from those
		// displaced positions inflates the baseline, which enlarges the ring,
		// which pushes them further -- the galaxy balloons on every tweak. The
		// "Re-center" command (which clears this.scales) is the deliberate way to
		// re-measure when the vault genuinely changes.
		let scale = this.scales.get(renderer);
		if (!scale) {
			let cx0 = 0;
			let cy0 = 0;
			for (const n of finite) {
				cx0 += n.x;
				cy0 += n.y;
			}
			cx0 /= finite.length;
			cy0 /= finite.length;
			let sumSq = 0;
			for (const n of finite) {
				const dx = n.x - cx0;
				const dy = n.y - cy0;
				sumSq += dx * dx + dy * dy;
			}
			scale = {
				baseline: Math.max(Math.sqrt(sumSq / finite.length), 50),
				center: { x: cx0, y: cy0 },
				nodeCount: renderer.nodes.length,
			};
			this.scales.set(renderer, scale);
		}
		const baseline = scale.baseline;
		const cx = scale.center.x;
		const cy = scale.center.y;

		// degree + adjacency, from renderer.links (most reliable), then fall
		// back to per-node forward/reverse, then to weight for degree only.
		const { degree, neighbors } = this.buildGraph(renderer, finite);

		let anchorId: string | null = null;
		let best = -1;
		for (const n of finite) {
			const d = degree.get(n.id) ?? 0;
			if (d > best) {
				best = d;
				anchorId = n.id;
			}
		}
		if (best <= 0) anchorId = null;

		const useOverride = this.overrideMatch.length > 0;
		const gk = (id: string) =>
			useOverride ? this.overrideKey(id) : this.autoKey(id);

		const classification = new Map<string, Classification>();
		const orphanIds: string[] = [];
		const groupSet = new Set<string>();
		for (const n of finite) {
			if (n.id === anchorId) {
				classification.set(n.id, { kind: "anchor" });
				continue;
			}
			if ((degree.get(n.id) ?? 0) === 0) {
				classification.set(n.id, { kind: "orphan" });
				orphanIds.push(n.id);
				continue;
			}
			const g = gk(n.id);
			if (g) {
				classification.set(n.id, { kind: "group", group: g });
				groupSet.add(g);
			} else {
				classification.set(n.id, { kind: "hub" });
			}
		}

		orphanIds.sort();
		const orphanIndex = new Map<string, number>();
		orphanIds.forEach((id, i) => orphanIndex.set(id, i));

		// Per-cluster "solar system": the most-connected member is the planet
		// (centre); the rest become moons (stable order = degree desc, then id).
		const members = new Map<string, string[]>();
		for (const [id, c] of classification) {
			if (c.kind === "group" && c.group) {
				(members.get(c.group) ?? members.set(c.group, []).get(c.group)!).push(id);
			}
		}
		for (const [, ids] of members) {
			ids.sort((a, b) => {
				const da = degree.get(a) ?? 0;
				const db = degree.get(b) ?? 0;
				if (db !== da) return db - da;
				return a < b ? -1 : a > b ? 1 : 0;
			});
			const moonCount = ids.length - 1;
			ids.forEach((id, i) => {
				const c = classification.get(id)!;
				if (i === 0) c.planet = true;
				else {
					c.moonIndex = i;
					c.moonCount = moonCount;
				}
			});
		}

		const groups = [...groupSet];
		const groupOrder = useOverride
			? this.overrideOrder.filter((g) => groupSet.has(g))
			: this.affinityOrder(groups, neighbors, classification);

		// Orbital geometry: well-connected clusters orbit CLOSER to the black
		// hole, peripheral ones further out -> varied, meaningful distances.
		const groupDeg = new Map<string, number>();
		for (const [id, c] of classification) {
			if (c.kind === "group" && c.group) {
				groupDeg.set(
					c.group,
					(groupDeg.get(c.group) ?? 0) + (degree.get(id) ?? 0)
				);
			}
		}
		let minD = Infinity;
		let maxD = -Infinity;
		for (const v of groupDeg.values()) {
			if (v < minD) minD = v;
			if (v > maxD) maxD = v;
		}
		const groupGeom = new Map<string, { radius: number; jitter: number }>();
		for (const g of groups) {
			const v = groupDeg.get(g) ?? 0;
			const norm = maxD > minD ? (v - minD) / (maxD - minD) : 0.5;
			const radius = 1.7 - 1.0 * norm; // central clusters closer (0.7..1.7)
			groupGeom.set(g, {
				radius,
				jitter: ((this.hash(g) % 1000) / 1000 - 0.5) * 2, // -1..1
			});
		}

		return {
			baseline,
			nodeCount: renderer.nodes.length,
			center: { x: cx, y: cy },
			anchorId,
			groupOrder,
			orphanIndex,
			classification,
			groupGeom,
			pinned: new Set<string>(),
		};
	}

	/** Degree + neighbour-id lists for every node, from the best source. */
	private buildGraph(
		renderer: GraphRenderer,
		finite: GraphNode[]
	): { degree: Map<string, number>; neighbors: Map<string, string[]> } {
		const degree = new Map<string, number>();
		const neighbors = new Map<string, string[]>();
		const link = (a?: string, b?: string) => {
			if (!a || !b) return;
			degree.set(a, (degree.get(a) ?? 0) + 1);
			degree.set(b, (degree.get(b) ?? 0) + 1);
			(neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
			(neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
		};

		const links = renderer.links;
		if (Array.isArray(links) && links.length > 0) {
			for (const l of links) link(l.source?.id, l.target?.id);
		} else {
			for (const n of finite) {
				const ids = [
					...Object.keys(n.forward ?? {}),
					...Object.keys(n.reverse ?? {}),
				];
				degree.set(n.id, ids.length);
				neighbors.set(n.id, ids);
			}
		}
		// Last-resort degree fallback so anchor selection still works.
		for (const n of finite) {
			if (!degree.has(n.id)) {
				degree.set(n.id, Math.round(n.weight ?? 0));
			}
		}
		return { degree, neighbors };
	}

	/** Place heavily-inter-linked groups next to each other (greedy chain). */
	private affinityOrder(
		groups: string[],
		neighbors: Map<string, string[]>,
		classification: Map<string, Classification>
	): string[] {
		if (groups.length <= 2) return [...groups].sort();

		const groupOf = (id: string) => {
			const c = classification.get(id);
			return c && c.kind === "group" ? c.group ?? null : null;
		};
		const aff = new Map<string, Map<string, number>>();
		const bump = (a: string | null, b: string | null) => {
			if (!a || !b || a === b) return;
			let m = aff.get(a);
			if (!m) {
				m = new Map();
				aff.set(a, m);
			}
			m.set(b, (m.get(b) ?? 0) + 1);
		};
		for (const [id, nbs] of neighbors) {
			const ga = groupOf(id);
			if (!ga) continue;
			for (const nb of nbs) bump(ga, groupOf(nb));
		}

		// start from the most-linked group, then always append the closest one
		const remaining = new Set(groups);
		let start = groups[0];
		let bestSum = -1;
		for (const g of groups) {
			let sum = 0;
			const m = aff.get(g);
			if (m) for (const v of m.values()) sum += v;
			if (sum > bestSum) {
				bestSum = sum;
				start = g;
			}
		}
		const order = [start];
		remaining.delete(start);
		while (remaining.size) {
			const last = order[order.length - 1];
			const m = aff.get(last);
			let pick: string | null = null;
			let bestv = -1;
			for (const g of remaining) {
				const v = (m && m.get(g)) ?? 0;
				if (v > bestv) {
					bestv = v;
					pick = g;
				}
			}
			if (pick == null) pick = [...remaining][0];
			order.push(pick);
			remaining.delete(pick);
		}
		return order;
	}

	/** Tiny stable string hash (for deterministic per-group angular jitter). */
	private hash(s: string): number {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
		return Math.abs(h);
	}

	/** Auto group key = the note's immediate parent folder (its directory). */
	private autoKey(id: string): string | null {
		const slash = id.lastIndexOf("/");
		if (slash < 0) return null; // vault-root file -> ungrouped
		return id.slice(0, slash);
	}

	/** Override group key = longest matching configured prefix. */
	private overrideKey(id: string): string | null {
		for (const p of this.overrideMatch) {
			if (id === p || id.startsWith(p + "/")) return p;
		}
		return null;
	}

	/* ---------------- pin management ---------------- */

	private unpin(
		renderer: GraphRenderer,
		node: GraphNode,
		state: RendererState
	) {
		node.fx = null;
		node.fy = null;
		try {
			renderer.worker.postMessage({
				forceNode: { id: node.id, x: null, y: null },
				alpha: this.settings.reheat,
				alphaTarget: 0,
				run: true,
			});
		} catch {
			/* ignore */
		}
		state.pinned.delete(node.id);
	}

	private releaseAll() {
		for (const renderer of this.getRenderers()) {
			const state = this.states.get(renderer);
			if (!state || state.pinned.size === 0) continue;
			for (const node of renderer.nodes || []) {
				if (!state.pinned.has(node.id)) continue;
				node.fx = null;
				node.fy = null;
				try {
					renderer.worker.postMessage({
						forceNode: { id: node.id, x: null, y: null },
						alpha: this.settings.reheat,
						alphaTarget: 0,
						run: true,
					});
				} catch {
					/* ignore */
				}
			}
			state.pinned.clear();
			try {
				renderer.changed();
			} catch {
				/* ignore */
			}
		}
	}

	private logDiagnostics() {
		const renderers = this.getRenderers();
		if (renderers.length === 0) {
			new Notice("No graph view open.");
			console.log("[orrery] no graph renderer found");
			return;
		}
		for (const renderer of renderers) {
			const nodes = renderer.nodes ?? [];
			const finite = nodes.filter(
				(n) => Number.isFinite(n.x) && Number.isFinite(n.y)
			);
			const links = renderer.links;
			const sample = nodes.slice(0, 5).map((n) => ({
				id: n.id,
				weight: n.weight,
				hasForward: !!n.forward,
				fwd: n.forward ? Object.keys(n.forward).length : "n/a",
				hasReverse: !!n.reverse,
				rev: n.reverse ? Object.keys(n.reverse).length : "n/a",
			}));
			const state = this.buildState(renderer, finite);
			const groupSizes: Record<string, number> = {};
			let orphanCount = 0;
			let hubCount = 0;
			for (const c of state.classification.values()) {
				if (c.kind === "group" && c.group)
					groupSizes[c.group] = (groupSizes[c.group] ?? 0) + 1;
				else if (c.kind === "orphan") orphanCount++;
				else if (c.kind === "hub") hubCount++;
			}
			console.log("[orrery] DIAGNOSTICS", {
				nodes: nodes.length,
				finite: finite.length,
				linksArray: Array.isArray(links)
					? `${links.length} links`
					: "NONE (renderer.links missing)",
				anchorId: state.anchorId,
				groupCount: Object.keys(groupSizes).length,
				orphanCount,
				hubCount,
				groupSizes,
				sampleNodes: sample,
			});
		}
		new Notice(
			"Galaxy diagnostics logged. Open the dev console (Cmd+Opt+I) to view."
		);
	}

	/**
	 * Best-effort: zoom the camera so the whole galaxy fits on first open, so it
	 * looks right regardless of vault size. Touches undocumented transform fields
	 * (guarded) -- a no-op if Obsidian's internals differ.
	 */
	private fitToView(renderer: GraphRenderer, state: RendererState) {
		try {
			const r = renderer as unknown as {
				width?: number;
				height?: number;
				scale?: number;
				targetScale?: number;
			};
			const w = r.width;
			const hgt = r.height;
			if (
				typeof w !== "number" ||
				typeof hgt !== "number" ||
				w <= 0 ||
				hgt <= 0
			)
				return;
			const R = state.baseline * this.settings.spread;
			// fit the outermost thing: the halo (~2.6R) or a further comet reach.
			const outer = Math.max(2.8, this.settings.cometReach + 0.3);
			const extent = 2 * outer * R;
			if (extent <= 0) return;
			const target = (0.9 * Math.min(w, hgt)) / extent;
			if (!isFinite(target) || target <= 0) return;
			if (typeof r.targetScale === "number") r.targetScale = target;
			if (typeof r.scale === "number") r.scale = target;
			renderer.changed();
		} catch {
			/* graph internals may differ across Obsidian versions */
		}
	}

	private getRenderers(): GraphRenderer[] {
		const out: GraphRenderer[] = [];
		for (const type of ["graph", "localgraph"]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const r = (leaf.view as any)?.renderer as
					| GraphRenderer
					| undefined;
				if (r && Array.isArray(r.nodes) && r.worker) out.push(r);
			}
		}
		return out;
	}
}

/* ------------------------- settings tab ------------------------- */

class ClusterSettingTab extends PluginSettingTab {
	plugin: GraphFolderClusterPlugin;

	constructor(app: App, plugin: GraphFolderClusterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: `Orrery v${this.plugin.manifest.version}`,
		});

		new Setting(containerEl)
			.setName("Reset to defaults")
			.setDesc("Restore every Orrery setting to the shipped defaults.")
			.addButton((b) =>
				b
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings = Object.assign(
							{},
							DEFAULT_SETTINGS,
							{
								overrideGroups: [
									...DEFAULT_SETTINGS.overrideGroups,
								],
							}
						);
						await this.plugin.saveSettings();
						this.display();
						new Notice("Orrery settings reset to defaults.");
					})
			);

		new Setting(containerEl)
			.setName("Enable folder clustering")
			.setDesc(
				"Arrange the graph into a galaxy: a central hub, folder clusters on a ring, and a halo of orphan notes."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Motion").setHeading();

		new Setting(containerEl)
			.setName("Galaxy motion (spin)")
			.setDesc(
				"Continuously rotate the galaxy (ring + halo) around the fixed central hub. Smooth, no jitter."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.motion).onChange(async (v) => {
					this.plugin.settings.motion = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Rotation speed")
			.setDesc("How fast the galaxy spins. Low = ambient drift.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 0.3, 0.01)
					.setValue(this.plugin.settings.rotationSpeed)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.rotationSpeed = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Moon orbit speed")
			.setDesc(
				"How fast moons orbit their planet. 1 = locked to the disk; higher = faster local orbit."
			)
			.addSlider((sl) =>
				sl
					.setLimits(1, 10, 0.5)
					.setValue(this.plugin.settings.moonSpeed)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.moonSpeed = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Layout").setHeading();

		new Setting(containerEl)
			.setName("Separation strength")
			.setDesc(
				"How hard each folder holds its ring zone. Higher = crisper separation."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 0.5, 0.01)
					.setValue(this.plugin.settings.strength)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.strength = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Group spread")
			.setDesc(
				"Ring radius. Higher = folders further apart. The orphan halo sits beyond the ring."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0.5, 5, 0.1)
					.setValue(this.plugin.settings.spread)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.spread = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Cluster tightness")
			.setDesc(
				"Size of each planet's moon disc. 1.0 = moons spread wide; lower = moons hug their planet tightly (more independent planets)."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0.1, 1.5, 0.05)
					.setValue(this.plugin.settings.tightness)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.tightness = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Comets").setHeading();

		new Setting(containerEl)
			.setName("Comet fraction")
			.setDesc(
				"Fraction of the Oort cloud (unlinked notes) that follow elongated, comet-like orbits diving in toward the black hole. 0 = all circular."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.cometFraction)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.cometFraction = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Comet speed")
			.setDesc(
				"How fast comets orbit, relative to the rest of the galaxy. Multiplies rotation speed."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0.5, 15, 0.5)
					.setValue(this.plugin.settings.cometSpeed)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.cometSpeed = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Comet reach")
			.setDesc(
				"How far OUT comets swing at their farthest (aphelion), relative to the ring radius."
			)
			.addSlider((sl) =>
				sl
					.setLimits(1.5, 4, 0.1)
					.setValue(this.plugin.settings.cometReach)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.cometReach = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Comet dive")
			.setDesc(
				"How CLOSE comets dive to the black hole at their nearest (perihelion). Lower = deeper plunge."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0.05, 2, 0.05)
					.setValue(this.plugin.settings.cometDive)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.cometDive = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("View").setHeading();

		new Setting(containerEl)
			.setName("Fit to view on open")
			.setDesc(
				"When a graph first opens, zoom so the whole galaxy fits on screen (handles different vault sizes)."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.fitOnLoad)
					.onChange(async (v) => {
						this.plugin.settings.fitOnLoad = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Manual group override (optional)")
			.setDesc(
				"Leave EMPTY for automatic grouping by folder. To force specific groups, list folder path prefixes (one per line); these define the groups and their clockwise ring order, longest match wins."
			)
			.addTextArea((ta) => {
				ta.setValue(this.plugin.settings.overrideGroups.join("\n"));
				ta.setPlaceholder(
					"(empty = automatic)\nwiki/systems/security\nwiki/systems/platform\n..."
				);
				ta.inputEl.rows = 8;
				ta.inputEl.style.width = "100%";
				ta.inputEl.style.fontFamily = "var(--font-monospace)";
				ta.onChange(async (v) => {
					this.plugin.settings.overrideGroups = v
						.split("\n")
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
					await this.plugin.saveSettings();
				});
			});

		const tip = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		tip.setText(
			"Grouping is automatic from your folder structure (each note clusters with its folder). The most-linked note becomes the central hub; link-free notes orbit the outer halo. " +
				"Commands: 'Toggle galaxy motion', 'Re-center / re-animate clusters'. Uses undocumented Obsidian internals; disable to revert instantly."
		);
	}
}
