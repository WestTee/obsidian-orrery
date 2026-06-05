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

type GroupBy = "folder" | "links";

interface ClusterSettings {
	enabled: boolean;
	motion: boolean;
	/**
	 * What defines a planet/cluster: "folder" (default, by parent folder) or
	 * "links" (link-communities, for vaults organised by links not folders).
	 */
	groupBy: GroupBy;
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
	/** Draw fading "comet tail" trails along planet + comet orbits. */
	showTrails: boolean;
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
	groupBy: "folder",
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
	showTrails: true,
	overrideGroups: [],
};

const OMEGA_HALO = 1.6; // Oort cloud drifts at its own rate (it's detached anyway)
const GOLDEN_ANGLE = 2.399963229728653; // even halo scatter
const MOTION_INTERVAL_MS = 33; // ~30fps while spinning
// Orbit trails: each body's fading "comet tail" is an arc swept BACKWARDS along
// its orbit from its current position. TRAIL_ARC = how far back (radians) the tail
// reaches; TRAIL_SEGMENTS = polyline resolution. Bright at the body, fading to 0.
const TRAIL_ARC = 2.6; // tail length in radians of orbital sweep (longer)
const TRAIL_SEGMENTS = 40;
const TRAIL_FALLOFF = 2.6; // opacity = (1-t)^this -> higher = sharper drop-off
// Notes in the vault root (no parent folder) cluster under this synthetic group
// so they orbit as a normal planet instead of collapsing into the centre. "/"
// can never collide with a real parent-folder path.
const ROOT_GROUP = "/";

/* ---- "Group by links" mode (hub-and-spokes clustering) ---- */
// The most-linked notes become hub "planets"; every other linked note joins the
// hub it links to most. Deterministic, cannot fragment, no per-vault tuning. The
// number of hubs scales with vault size (sqrt), bounded, so a small vault gets a
// few planets and a large one gets more, without exploding.
const LINK_HUBS_MIN = 6;
const LINK_HUBS_MAX = 40;
const LINK_HUBS_SQRT_DIV = 6; // hubs ~= sqrt(linkedCount) * (this-derived factor)

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

type NodeKind = "anchor" | "orphan" | "group";
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
	/** per-group base angle (radians, before spin) -- folder "arms" sectors in
	 * plain folder mode, golden-angle scatter in links/override mode. */
	groupAngle: Map<string, number>;
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

	/** per-renderer transparent overlay canvas for orbit trails. */
	private trailCanvas = new WeakMap<GraphRenderer, HTMLCanvasElement>();
	/** per-renderer comet position history (node id -> recent WORLD positions,
	 * newest last) so comet trails follow the dot's ACTUAL eased path. */
	private cometHistory = new WeakMap<
		GraphRenderer,
		Map<string, { x: number; y: number }[]>
	>();

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
		for (const renderer of this.getRenderers()) this.removeTrailCanvas(renderer);
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
		// Re-fit the camera on the next frame so layout changes (esp. group
		// spread) stay in view. fitToView holds the galaxy centre fixed while it
		// zooms, so this re-frames rather than losing the galaxy off-screen.
		this.fitted = new WeakSet();
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
		if (!this.settings.enabled || this.settings.strength <= 0) {
			// plugin disabled -> ensure no stale trail overlays linger
			for (const renderer of this.getRenderers())
				this.removeTrailCanvas(renderer);
			return;
		}

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

		// Bail on a degenerate viewport. On some multi-monitor / display-scaling
		// setups Obsidian reports the graph pane as a tiny width/height (e.g. ~150
		// or 0) on a secondary screen. Computing the layout and pinning every node
		// into that collapsed space draws a garbage "swirl". When the viewport is
		// too small, release our pins (so the native graph shows) and skip until
		// it reports a real size again.
		const rr = renderer as unknown as { width?: number; height?: number };
		const vw = typeof rr.width === "number" ? rr.width : 1;
		const vh = typeof rr.height === "number" ? rr.height : 1;
		if (vw < 200 || vh < 200) {
			this.releaseAll();
			this.removeTrailCanvas(renderer);
			return;
		}

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
			// Base angle is precomputed in buildState (folder "arms" sectors, or
			// golden-angle scatter for links/override). One rigid rate for the
			// whole disk -> clusters keep their spacing and never drift apart.
			const baseAngle =
				state.groupAngle.get(order[i]) ?? i * GOLDEN_ANGLE;
			const angle = baseAngle + this.phase * speed;
			const zr = R * rFactor;
			zones[order[i]] = {
				x: cx + zr * Math.cos(angle),
				y: cy + zr * Math.sin(angle),
				r: zr,
			};
		}

		// Orbit trails (fading comet-tails) are drawn on a transparent overlay,
		// mapped through the live renderer transform so they track zoom + pan.
		this.drawTrails(renderer, state, cx, cy, R, speed);

		const s = this.settings.strength;
		const eps = Math.max(0.5, R * 0.002);
		let maxMoved = 0;
		const updates: { node: GraphNode; x: number; y: number; ease?: number }[] = [];

		for (const n of finite) {
			if (n === renderer.dragNode) continue;
			const c = state.classification.get(n.id);
			if (!c) continue;

			let tx: number;
			let ty: number;
			// comets need to ease much harder than the disk: at perihelion the
			// Kepler target whips around the black hole, and a slow lerp cuts the
			// corner (the dot turns back before going around). A near-1 ease makes
			// the dot actually follow the fast sweep and visibly wrap the centre.
			let ease = s;

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
					// Disc grows with sqrt(member count) so a big folder spreads
					// into a large readable disc instead of all its moons piling
					// up; small folders stay tight. Bounded by the room to the
					// neighbouring planet (arc) and an absolute cap.
					const want = R * 0.22 * Math.sqrt(m / 8);
					const moonR = Math.min(want, arc * 0.5, R * 0.9) * tight;
					// Orbital shells. Moons are already ordered by degree (most-
					// linked first), so bucket them into concentric rings: ring r
					// holds 2r+1 moons -> the high-degree notes land in the inner
					// rings, leaf notes in the outer ones. Each ring spins at its
					// own rate (inner faster = Keplerian), so a big cluster reads
					// as orbital shells, not one blob. All derived from degree rank
					// + count, and local to the cluster (no inter-cluster overlap).
					const shell = Math.floor(Math.sqrt(i - 1));
					const nShells = Math.floor(Math.sqrt(m - 1)) + 1;
					const ringStart = shell * shell + 1;
					const ringSize = Math.min(2 * shell + 1, m - ringStart + 1);
					const jInRing = i - ringStart;
					const rr = moonR * (0.2 + 0.8 * ((shell + 1) / nShells));
					const ringSpeed =
						this.settings.moonSpeed *
						(1 + 0.6 * (1 - shell / Math.max(1, nShells - 1)));
					const theta =
						shell * GOLDEN_ANGLE +
						(jInRing / Math.max(1, ringSize)) * 2 * Math.PI +
						this.phase * speed * ringSpeed;
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
					const p = this.cometPos(cx, cy, R, h, i, speed, this.phase);
					tx = p.x;
					ty = p.y;
					ease = 0.9; // track the fast perihelion sweep, wrap the BH
				} else {
					const angle =
						i * GOLDEN_ANGLE + this.phase * speed * OMEGA_HALO;
					tx = cx + apo * Math.cos(angle);
					ty = cy + apo * Math.sin(angle);
				}
			} else {
				// no other kinds exist (every note is anchor/group/orphan)
				continue;
			}

			const nx = n.x + ease * (tx - n.x);
			const ny = n.y + ease * (ty - n.y);
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
		// Link mode: detect communities from the link graph (anchor + zero-link
		// notes excluded), and use the community as each note's group. Override is
		// folder-mode only, so it disables link mode. Falls back to folder grouping
		// for anything LPA didn't place (shouldn't happen, but safe).
		const linkMode = this.settings.groupBy === "links" && !useOverride;
		let communities: Map<string, string> | null = null;
		if (linkMode) {
			const linkedForClustering = finite
				.map((n) => n.id)
				.filter(
					(id) => id !== anchorId && (degree.get(id) ?? 0) > 0
				);
			communities = this.linkClusters(
				linkedForClustering,
				degree,
				neighbors
			);
		}
		const gk = (id: string) =>
			linkMode
				? communities!.get(id) ?? this.autoKey(id)
				: useOverride
				? this.overrideKey(id)
				: this.autoKey(id);

		// Attachments (non-markdown files: images, PDFs, ...) are real files with
		// real folder paths, but an embed usually isn't a counted link, so they'd
		// otherwise fall through as zero-link orphans (comets). Group them by
		// folder like notes regardless of degree; only link-free *notes* form the
		// Oort cloud. Tag/phantom nodes have no file extension, so they're skipped.
		const isAttachment = (id: string) =>
			/\.[a-z0-9]+$/i.test(id) && !id.toLowerCase().endsWith(".md");

		const classification = new Map<string, Classification>();
		const orphanIds: string[] = [];
		const groupSet = new Set<string>();
		for (const n of finite) {
			if (n.id === anchorId) {
				classification.set(n.id, { kind: "anchor" });
				continue;
			}
			if ((degree.get(n.id) ?? 0) === 0 && !isAttachment(n.id)) {
				classification.set(n.id, { kind: "orphan" });
				orphanIds.push(n.id);
				continue;
			}
			// Every linked note gets a home (community in link mode, folder
			// otherwise); anything without one clusters as ROOT_GROUP so nothing is
			// left homeless to collapse into the centre.
			const g = gk(n.id) ?? ROOT_GROUP;
			classification.set(n.id, { kind: "group", group: g });
			groupSet.add(g);
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
		// Link mode: rank planets by degree and spread them EVENLY across the
		// radial band by rank, so distances are genuinely distributed (some near
		// the black hole, some far) rather than all bunched on one ring. (Degrees
		// of link clusters tend to be similar, so a degree-normalised radius
		// clumps; rank guarantees spread.) Folder mode keeps its degree formula.
		const rankRadius = new Map<string, number>();
		if (linkMode) {
			const ordered = [...groups].sort((a, b) => {
				const da = groupDeg.get(a) ?? 0;
				const db = groupDeg.get(b) ?? 0;
				if (db !== da) return db - da; // most-connected first (closest in)
				return a < b ? -1 : 1;
			});
			const n = Math.max(1, ordered.length - 1);
			ordered.forEach((g, i) => {
				// even spread across an inner band 0.45..1.7 (inside the 2.1 halo),
				// plus a per-planet jitter so it's not a perfect spiral.
				const t = ordered.length === 1 ? 0.5 : i / n;
				const base = 0.45 + 1.25 * t;
				const jit = ((this.hash(g + "#r") % 1000) / 1000 - 0.5) * 0.35;
				rankRadius.set(g, Math.min(1.8, Math.max(0.4, base + jit)));
			});
		}

		const groupGeom = new Map<string, { radius: number; jitter: number }>();
		for (const g of groups) {
			const v = groupDeg.get(g) ?? 0;
			const norm = maxD > minD ? (v - minD) / (maxD - minD) : 0.5;
			const radius = linkMode
				? rankRadius.get(g) ?? 1
				: 1.7 - 1.0 * norm; // folder mode: unchanged (0.7..1.7)
			groupGeom.set(g, {
				radius,
				jitter: ((this.hash(g) % 1000) / 1000 - 0.5) * 2, // -1..1
			});
		}

		// Folder "arms": in plain folder mode, cluster each top folder's whole
		// subtree into one CONTIGUOUS angular sector, so subfolders sit near
		// their parent instead of being flung apart by the golden-angle scatter.
		// Angle-only -- radii (groupGeom) are untouched, so varied distances and
		// the Oort cloud sitting outside everything are preserved. Links mode and
		// manual override keep the legacy golden-angle placement unchanged.
		const groupAngle = new Map<string, number>();
		const folderArms = !linkMode && !useOverride;
		if (folderArms && groupOrder.length > 0) {
			// 1. Family level (auto-trunk): descend PAST any wrapping trunk -- a
			//    folder that holds the majority of the vault's planets (like a
			//    single "wiki/" root) -- and split at the first level that
			//    actually branches. A few small sibling folders at the root
			//    (e.g. "raw/", a stray "../" link) must NOT stop the descent, or
			//    the whole trunk collapses into one giant arm.
			const folderGroups = groupOrder.filter((g) => g !== ROOT_GROUP);
			let maxDepth = 1;
			for (const g of folderGroups)
				maxDepth = Math.max(maxDepth, g.split("/").length);
			let familyDepth = 1;
			for (let d = 1; d <= maxDepth; d++) {
				const counts = new Map<string, number>();
				for (const g of folderGroups) {
					const parts = g.split("/");
					if (parts.length >= d) {
						const pre = parts.slice(0, d).join("/");
						counts.set(pre, (counts.get(pre) ?? 0) + 1);
					}
				}
				let top = 0;
				for (const c of counts.values()) top = Math.max(top, c);
				// One prefix dominates (a trunk) -> keep descending into it.
				if (counts.size <= 1 || top > folderGroups.length / 2) {
					familyDepth = d + 1;
					continue;
				}
				// First level that genuinely branches -> families live here.
				familyDepth = d;
				break;
			}
			familyDepth = Math.min(familyDepth, maxDepth);
			const famOf = (g: string) =>
				g === ROOT_GROUP
					? ROOT_GROUP
					: g.split("/").slice(0, familyDepth).join("/");

			// 2. Bucket planets into families, preserving affinity order both
			//    within a family and across families (first appearance wins).
			const families = new Map<string, string[]>();
			const familyOrder: string[] = [];
			for (const g of groupOrder) {
				const f = famOf(g);
				let arr = families.get(f);
				if (!arr) {
					arr = [];
					families.set(f, arr);
					familyOrder.push(f);
				}
				arr.push(g);
			}

			// 3. Give each family a contiguous wedge sized LINEARLY by its planet
			//    count, so every planet gets an equal angular slice (uniform
			//    planet-density around the ring -- no sparse pockets where a small
			//    family claims a wide wedge it can't fill). A small total gap
			//    between arms keeps them readable (per-gap shrinks as count grows).
			const nFam = familyOrder.length;
			const weightOf = (f: string) => families.get(f)!.length;
			let totalW = 0;
			for (const f of familyOrder) totalW += weightOf(f);
			const gapFrac = nFam <= 1 ? 0 : 0.12;
			const usable = 2 * Math.PI * (1 - gapFrac);
			const perGap = nFam <= 1 ? 0 : (2 * Math.PI * gapFrac) / nFam;

			const rInner = 0.6;
			const rOuter = 1.65;
			let cursor = 0;
			for (const f of familyOrder) {
				const planets = families.get(f)!;
				const wedge =
					totalW > 0 ? usable * (weightOf(f) / totalW) : usable;
				const k = planets.length;
				const slot = wedge / Math.max(1, k);
				// Angle: even spread across the wedge (affinity order) + small
				// deterministic jitter, clamped so a planet never leaks into the
				// neighbouring arm.
				planets.forEach((g, j) => {
					const t = k === 1 ? 0.5 : (j + 0.5) / k;
					const jit =
						((this.hash(g) % 1000) / 1000 - 0.5) * slot * 0.5;
					const lo = cursor + slot * 0.15;
					const hi = cursor + wedge - slot * 0.15;
					const a = Math.min(hi, Math.max(lo, cursor + t * wedge + jit));
					groupAngle.set(g, a);
				});
				// Radius: spread the same planets across a radial band by
				// connectivity rank (the arm's hub pulls inward, leaf folders sit
				// outward), so an arm fills 2D space toward the black hole instead
				// of all sitting on one outer line. Radius rank and angular order
				// are independent -> a 2D scatter, not a diagonal streak. This
				// overrides the per-folder connectivity radius for folder mode.
				const byDeg = [...planets].sort((a, b) => {
					const da = groupDeg.get(a) ?? 0;
					const db = groupDeg.get(b) ?? 0;
					if (db !== da) return db - da;
					return a < b ? -1 : a > b ? 1 : 0;
				});
				byDeg.forEach((g, rank) => {
					const tr = k === 1 ? 0.45 : rank / (k - 1);
					const span = (rOuter - rInner) / Math.max(2, k);
					const rjit =
						((this.hash(g + "#rad") % 1000) / 1000 - 0.5) *
						span *
						0.9;
					const radius = Math.min(
						1.75,
						Math.max(0.5, rInner + (rOuter - rInner) * tr + rjit)
					);
					const prev = groupGeom.get(g);
					groupGeom.set(g, {
						radius,
						jitter: prev?.jitter ?? 0,
					});
				});
				cursor += wedge + perGap;
			}
		} else {
			// Legacy golden-angle scatter (links mode / manual override):
			// preserved exactly so those modes are unchanged.
			const slot = (2 * Math.PI) / Math.max(1, groupOrder.length);
			groupOrder.forEach((g, i) => {
				const jitter = (groupGeom.get(g)?.jitter ?? 0) * slot * 0.35;
				groupAngle.set(g, i * GOLDEN_ANGLE + jitter);
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
			groupAngle,
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

	/**
	 * Hub-and-spokes link clustering (for "group by links" mode). The most-linked
	 * notes become hub "planets"; every other linked note joins the hub it links to
	 * most. Deterministic (fixed id-sorted order, degree+id tie-breaks), cannot
	 * fragment into singletons, and needs no per-vault tuning -- robust on any
	 * vault. The result is fed into the SAME planet/moon layout as folders.
	 *
	 * @param ids       linked note ids to cluster (anchor + orphans excluded)
	 * @param degree    degree per id (for ranking hubs)
	 * @param neighbors full adjacency
	 * @returns map of note id -> hub id (its planet/group key)
	 */
	private linkClusters(
		ids: string[],
		degree: Map<string, number>,
		neighbors: Map<string, string[]>
	): Map<string, string> {
		const group = new Map<string, string>();
		if (ids.length === 0) return group;

		// choose hub count ~ sqrt(linked), bounded; deterministic ordering by
		// degree desc then id so the same vault always picks the same hubs.
		const byDeg = [...ids].sort((a, b) => {
			const da = degree.get(a) ?? 0;
			const db = degree.get(b) ?? 0;
			if (db !== da) return db - da;
			return a < b ? -1 : a > b ? 1 : 0;
		});
		const hubCount = Math.max(
			LINK_HUBS_MIN,
			Math.min(
				LINK_HUBS_MAX,
				Math.round((Math.sqrt(ids.length) * 6) / LINK_HUBS_SQRT_DIV)
			)
		);
		const hubs = byDeg.slice(0, Math.min(hubCount, byDeg.length));
		const hubSet = new Set(hubs);
		const hubRank = new Map(hubs.map((h, i) => [h, i])); // lower = stronger
		for (const h of hubs) group.set(h, h); // each hub is its own planet centre

		// pass 1: non-hub notes join the hub they link to most (tie -> stronger hub)
		const sorted = [...ids].sort();
		for (const id of sorted) {
			if (hubSet.has(id)) continue;
			const tally = new Map<string, number>();
			for (const n of neighbors.get(id) ?? [])
				if (hubSet.has(n)) tally.set(n, (tally.get(n) ?? 0) + 1);
			let best: string | null = null;
			let bestC = -1;
			for (const [h, c] of tally) {
				if (
					c > bestC ||
					(c === bestC &&
						best !== null &&
						(hubRank.get(h) ?? 1e9) < (hubRank.get(best) ?? 1e9))
				) {
					best = h;
					bestC = c;
				}
			}
			if (best) group.set(id, best);
		}

		// pass 2: notes with no direct hub link join the hub of their most-linked
		// already-assigned neighbour (repeat a few times to propagate outward).
		for (let pass = 0; pass < 4; pass++) {
			let changed = false;
			for (const id of sorted) {
				if (group.has(id)) continue;
				const tally = new Map<string, number>();
				for (const n of neighbors.get(id) ?? []) {
					const g = group.get(n);
					if (g) tally.set(g, (tally.get(g) ?? 0) + 1);
				}
				let best: string | null = null;
				let bestC = -1;
				for (const [g, c] of tally) {
					if (c > bestC || (c === bestC && (best === null || g < best))) {
						best = g;
						bestC = c;
					}
				}
				if (best) {
					group.set(id, best);
					changed = true;
				}
			}
			if (!changed) break;
		}

		// fallback: anything still unassigned joins the strongest hub
		for (const id of sorted) if (!group.has(id)) group.set(id, hubs[0]);
		return group;
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
		// Vault-root notes cluster as the ROOT_GROUP planet rather than being
		// left homeless (which used to collapse them into the black hole).
		if (slash < 0) return ROOT_GROUP;
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
			for (const c of state.classification.values()) {
				if (c.kind === "group" && c.group)
					groupSizes[c.group] = (groupSizes[c.group] ?? 0) + 1;
				else if (c.kind === "orphan") orphanCount++;
			}
			// Folder "arms": list each planet by its base angle (deg) so the
			// angular sectors are visible -- contiguous angles = one arm; a jump
			// in angle = an inter-arm gap. Lets you verify subfolders of the same
			// parent land next to each other.
			const arms = [...state.groupAngle.entries()]
				.sort((a, b) => a[1] - b[1])
				.map(([g, a]) => ({
					group: g,
					deg: Math.round(((a % (2 * Math.PI)) * 180) / Math.PI),
					rFactor: +(state.groupGeom.get(g)?.radius ?? 0).toFixed(2),
					size: groupSizes[g] ?? 0,
				}));
			console.log("[orrery] DIAGNOSTICS", {
				nodes: nodes.length,
				finite: finite.length,
				linksArray: Array.isArray(links)
					? `${links.length} links`
					: "NONE (renderer.links missing)",
				anchorId: state.anchorId,
				groupCount: Object.keys(groupSizes).length,
				orphanCount,
				rootGroupSize: groupSizes[ROOT_GROUP] ?? 0,
				groupSizes,
				armsByAngle: arms,
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
				panX?: number;
				panY?: number;
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
			// Hold the galaxy CENTRE fixed on screen while we change zoom, so
			// fitting (esp. at large spread) re-frames instead of shoving the
			// galaxy out of view. screen = world*scale + pan, so to keep centre c
			// put: newPan = oldPan + c*(oldScale - newScale). No-op on first load
			// (centre ~origin); the crucial correction when scale shrinks a lot.
			const oldScale = typeof r.scale === "number" ? r.scale : target;
			const dScale = oldScale - target;
			if (isFinite(dScale)) {
				if (typeof r.panX === "number")
					r.panX += state.center.x * dScale;
				if (typeof r.panY === "number")
					r.panY += state.center.y * dScale;
			}
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

	/**
	 * Comet world-position for hash h, orphan index i, at a given phase. Pulled out
	 * of updateRenderer so the orbit-trail renderer evaluates the EXACT same Kepler
	 * path (passing earlier phases traces where the comet just was).
	 */
	private cometPos(
		cx: number,
		cy: number,
		R: number,
		h: number,
		i: number,
		speed: number,
		phase: number
	): { x: number; y: number } {
		const reach =
			R * this.settings.cometReach * (0.85 + 0.3 * ((h % 97) / 97));
		let dive =
			R * this.settings.cometDive * (0.7 + 0.6 * (((h >> 3) % 97) / 97));
		if (dive > reach * 0.9) dive = reach * 0.9;
		const a = (reach + dive) / 2;
		const ecc = (reach - dive) / (reach + dive);
		const periDir = ((h * 0.6180339887) % 1) * 2 * Math.PI;
		const M = i * GOLDEN_ANGLE + phase * speed * this.settings.cometSpeed;
		let E = M;
		for (let k = 0; k < 6; k++) {
			E = E - (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
		}
		const nu =
			2 *
			Math.atan2(
				Math.sqrt(1 + ecc) * Math.sin(E / 2),
				Math.sqrt(1 - ecc) * Math.cos(E / 2)
			);
		const r = a * (1 - ecc * Math.cos(E));
		const ang = periDir + nu;
		return { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
	}

	/* ---------------- orbit trails ---------------- */

	/** The real graph <canvas> the renderer draws nodes into (robust lookup). */
	private graphCanvasEl(renderer: GraphRenderer): HTMLCanvasElement | null {
		const rr = renderer as any;
		// 1) the usual handles
		for (const cand of [rr.px?.view, rr.canvas]) {
			if (cand instanceof HTMLCanvasElement) return cand;
		}
		// 2) fall back to the first <canvas> in this renderer's graph leaf
		for (const type of ["graph", "localgraph"]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				if ((leaf.view as any)?.renderer === renderer) {
					const cont = (leaf.view as any)?.containerEl as
						| HTMLElement
						| undefined;
					// exclude our own overlay canvas
					const cv = cont?.querySelector(
						"canvas:not(.orrery-trail-overlay)"
					);
					if (cv instanceof HTMLCanvasElement) return cv;
				}
			}
		}
		return null;
	}

	/**
	 * The transparent overlay canvas for a renderer (created on first use). It is
	 * appended as a SIBLING of the graph canvas and positioned/sized each frame to
	 * exactly match the graph canvas's own box (see syncOverlayToGraphCanvas), so
	 * trails share the identical coordinate space as the nodes on any monitor.
	 */
	private ensureTrailCanvas(renderer: GraphRenderer): HTMLCanvasElement | null {
		let canvas = this.trailCanvas.get(renderer);
		if (canvas && canvas.isConnected) return canvas;
		const gcv = this.graphCanvasEl(renderer);
		const parent = gcv?.parentElement;
		if (!parent) return null;
		canvas = document.createElement("canvas");
		canvas.addClass("orrery-trail-overlay");
		Object.assign(canvas.style, {
			position: "absolute",
			pointerEvents: "none",
			zIndex: "1",
		} as Partial<CSSStyleDeclaration>);
		if (getComputedStyle(parent).position === "static")
			parent.style.position = "relative";
		parent.appendChild(canvas);
		this.trailCanvas.set(renderer, canvas);
		return canvas;
	}

	private removeTrailCanvas(renderer: GraphRenderer) {
		const c = this.trailCanvas.get(renderer);
		if (c) {
			c.remove();
			this.trailCanvas.delete(renderer);
		}
	}

	/**
	 * Draw a fading "comet tail" arc behind each planet and comet, swept backwards
	 * along its actual orbit. World->screen uses the live renderer transform
	 * (screen = world * scale + pan), so trails stay glued to the bodies through
	 * zoom, pan and any setting change. Bright at the body, fading to nothing.
	 */
	private drawTrails(
		renderer: GraphRenderer,
		state: RendererState,
		cx: number,
		cy: number,
		R: number,
		speed: number
	) {
		if (!this.settings.showTrails) {
			this.removeTrailCanvas(renderer);
			return;
		}
		const canvas = this.ensureTrailCanvas(renderer);
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		// live transform (all undocumented internals; guard everything)
		const rr = renderer as any;
		const scale: number =
			typeof rr.scale === "number" ? rr.scale : NaN;
		const panX: number = typeof rr.panX === "number" ? rr.panX : NaN;
		const panY: number = typeof rr.panY === "number" ? rr.panY : NaN;
		if (!isFinite(scale) || !isFinite(panX) || !isFinite(panY)) {
			return; // transform not available on this build -> silently skip
		}

		// Mirror the REAL graph canvas exactly: same on-screen box, same backing
		// store. The renderer's pan/scale map world coords into the graph canvas's
		// backing-pixel space, so by copying that canvas's geometry our overlay
		// shares the identical coordinate space as the nodes -- on any monitor.
		const gcv = this.graphCanvasEl(renderer);
		if (!gcv) return;
		const gRect = gcv.getBoundingClientRect();
		if (gRect.width < 200 || gRect.height < 200) {
			// degenerate viewport (e.g. collapsed pane on a 2nd monitor) -> skip
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}
		// The nodes are drawn by PIXI into its renderer BUFFER, whose size can
		// differ from the <canvas> backing store (e.g. buffer 1610x1568 while the
		// canvas backing is 805x784 = half). renderer.panX/panY/scale map world
		// coords into that BUFFER space. So our overlay backing must match the
		// PIXI buffer, not the canvas backing -- otherwise everything is drawn at
		// the wrong scale/offset (the corner "swirl"). We still stretch the CSS to
		// fill the pane (inset:0/100%) exactly like the graph canvas does.
		const pxr = (renderer as any).px?.renderer;
		const bw =
			pxr && typeof pxr.width === "number" && pxr.width > 0
				? pxr.width
				: gcv.width;
		const bh =
			pxr && typeof pxr.height === "number" && pxr.height > 0
				? pxr.height
				: gcv.height;
		canvas.style.left = "0";
		canvas.style.top = "0";
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		if (canvas.width !== bw || canvas.height !== bh) {
			canvas.width = bw;
			canvas.height = bh;
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, bw, bh);
		const toS = (wx: number, wy: number): [number, number] => [
			wx * scale + panX,
			wy * scale + panY,
		];

		// ---- planet orbital trails: arc backwards along each planet's circle ----
		// Anchor each arc to the planet's ACTUAL on-screen dot (it eases toward its
		// target, so it lags the computed angle) -> trail starts exactly on the
		// planet and trails behind it.
		const planetNode = new Map<string, GraphNode>();
		for (const n of renderer.nodes) {
			const c = state.classification.get(n.id);
			if (c && c.kind === "group" && c.planet && c.group)
				planetNode.set(c.group, n);
		}
		// Link mode places planets far out at a tiny scale, so the subtle folder-
		// mode arc becomes a sub-pixel sliver lost in the link lines. Use bolder,
		// longer arcs there. Folder mode keeps its original subtle look.
		const linkMode = this.settings.groupBy === "links";
		const arcWidth = linkMode ? 2.6 : 1.6;
		const arcAlpha = linkMode ? 0.4 : 0.18;
		const arcSweep = linkMode ? TRAIL_ARC * 1.6 : TRAIL_ARC;
		for (const g of state.groupOrder) {
			const geom = state.groupGeom.get(g);
			const pn = planetNode.get(g);
			// Use the planet's ACTUAL distance + angle so the arc sits exactly on
			// it (falls back to the computed radius/0 if the node is missing).
			const zr = pn
				? Math.hypot(pn.x - cx, pn.y - cy)
				: R * (geom?.radius ?? 1);
			const angle = pn ? Math.atan2(pn.y - cy, pn.x - cx) : 0;
			this.strokeFadingArc(
				ctx,
				toS,
				cx,
				cy,
				zr,
				angle,
				scale,
				arcWidth,
				arcAlpha,
				arcSweep
			);
		}

		// ---- comet trails: follow the dot's ACTUAL recent path ----
		// The node eases toward its target, so its real path is a smoothed, lagged
		// version of the math ellipse. Modelling it never matched; instead we
		// record where the dot has actually been and draw through that history.
		let hist = this.cometHistory.get(renderer);
		if (!hist) {
			hist = new Map();
			this.cometHistory.set(renderer, hist);
		}
		const liveComets = new Set<string>();
		for (const n of renderer.nodes) {
			const c = state.classification.get(n.id);
			if (!c || c.kind !== "orphan") continue;
			const h = this.hash(n.id);
			const isComet =
				this.settings.cometFraction > 0 &&
				(h % 1000) / 1000 < this.settings.cometFraction;
			if (!isComet) continue;
			liveComets.add(n.id);
			let pts = hist.get(n.id);
			if (!pts) {
				pts = [];
				hist.set(n.id, pts);
			}
			// append current real position; cap history length
			pts.push({ x: n.x, y: n.y });
			if (pts.length > TRAIL_SEGMENTS) pts.shift();
			this.strokeHistoryTrail(ctx, toS, pts);
		}
		// drop history for anything no longer a comet (e.g. settings change)
		for (const id of [...hist.keys()]) if (!liveComets.has(id)) hist.delete(id);
	}

	/** Stroke a fading line through a body's recorded world positions (newest last). */
	private strokeHistoryTrail(
		ctx: CanvasRenderingContext2D,
		toS: (x: number, y: number) => [number, number],
		pts: { x: number; y: number }[]
	) {
		if (pts.length < 2) return;
		ctx.lineCap = "round";
		const n = pts.length;
		for (let s = 1; s < n; s++) {
			const a = toS(pts[s - 1].x, pts[s - 1].y);
			const b = toS(pts[s].x, pts[s].y);
			// newest (head) = brightest; t=0 at head, 1 at oldest tail
			const t = 1 - s / (n - 1);
			const alpha = Math.pow(1 - t, TRAIL_FALLOFF) * 0.32;
			ctx.strokeStyle = `rgba(190,195,205,${alpha.toFixed(3)})`;
			ctx.lineWidth = Math.max(0.5, 1.6 * (1 - t));
			ctx.beginPath();
			ctx.moveTo(a[0], a[1]);
			ctx.lineTo(b[0], b[1]);
			ctx.stroke();
		}
	}

	/** Stroke a circular orbit arc that fades from the body backwards. */
	private strokeFadingArc(
		ctx: CanvasRenderingContext2D,
		toS: (x: number, y: number) => [number, number],
		cx: number,
		cy: number,
		radius: number,
		headAngle: number,
		scale: number,
		width: number,
		peakAlpha = 0.18,
		sweep = TRAIL_ARC
	) {
		ctx.lineCap = "round";
		for (let s = 0; s < TRAIL_SEGMENTS; s++) {
			const t0 = s / TRAIL_SEGMENTS;
			const t1 = (s + 1) / TRAIL_SEGMENTS;
			// segment angles trailing BEHIND the head (head at t=0)
			const a0 = headAngle - t0 * sweep;
			const a1 = headAngle - t1 * sweep;
			const [x0, y0] = toS(
				cx + radius * Math.cos(a0),
				cy + radius * Math.sin(a0)
			);
			const [x1, y1] = toS(
				cx + radius * Math.cos(a1),
				cy + radius * Math.sin(a1)
			);
			// sharper drop-off: opacity = (1-t)^TRAIL_FALLOFF. Neutral grey to
			// match the graph's link lines.
			const alpha = Math.pow(1 - t0, TRAIL_FALLOFF) * peakAlpha;
			ctx.strokeStyle = `rgba(190,195,205,${alpha.toFixed(3)})`;
			ctx.lineWidth = Math.max(0.5, width * (0.5 + 0.5 * (1 - t0)));
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(x1, y1);
			ctx.stroke();
		}
	}

	/** Stroke a comet's fading tail by sampling its Kepler path at past phases. */
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

		new Setting(containerEl)
			.setName("Group by")
			.setDesc(
				"What defines a planet. Folder: cluster by parent folder (default). Links: cluster by link-communities - for vaults organised by links rather than folders."
			)
			.addDropdown((d) =>
				d
					.addOption("folder", "Folder (default)")
					.addOption("links", "Links")
					.setValue(this.plugin.settings.groupBy)
					.onChange(async (v) => {
						this.plugin.settings.groupBy = v as GroupBy;
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
				"Ring radius. Higher = folders further apart. The orphan halo sits beyond the ring. The camera auto-zooms to keep the whole galaxy in view."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0.5, 10, 0.1)
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

		new Setting(containerEl)
			.setName("Orbit trails")
			.setDesc(
				"Draw a fading comet-tail along each planet's and comet's orbital path."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showTrails)
					.onChange(async (v) => {
						this.plugin.settings.showTrails = v;
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
