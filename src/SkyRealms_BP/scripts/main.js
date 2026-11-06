/**
 * Sky Realms — gameplay scripts.
 *
 *  - Flight state: vehicles/creatures switch gravity off while a player is steering them.
 *  - Fuel: vehicles burn fuel while flying; coal/charcoal/blaze powder refuels (data-driven interact).
 *  - Safety: players who hop off mid-air get Slow Falling.
 *  - Sky Blaster: fires lasers from a Sky Fighter and fireballs from a Fire Dragon.
 *  - Cargo Blimp: carries a chest-like Cargo Hold that follows it.
 *  - Pack up: sneak + hit a vehicle to turn it back into its kit item.
 *  - Dragon eggs (Fire Dragon and Peter): hatchlings bond with the nearest player.
 *  - Sky races: Race Rings build glowing checkpoints; the Race Flag starts a timed run with best laps.
 *  - Island Seeds: grow a floating island right under you.
 *  - Clouds: bouncy Cloud Blocks (no fall damage), Cloud Seeds that grow puffy cloud islands.
 *  - Cloud Portals: lead up to the secret Cloud Realm, with a castle hidden inside a big cloud.
 */
import { GameMode, ItemStack, Player, system, world, } from "@minecraft/server";
const FLYERS = {
    "sky:fighter": { burnTicks: 40, kit: "sky:fighter_kit", label: "Sky Fighter", hint: "Use the Sky Blaster to fire" },
    "sky:hoverboard": { burnTicks: 60, kit: "sky:hoverboard_kit", label: "Hoverboard", hint: "Hold jump to climb" },
    "sky:blimp": { burnTicks: 100, kit: "sky:blimp_kit", label: "Cargo Blimp", hint: "Tap the crate to open the cargo hold" },
    "sky:dragon": { label: "Fire Dragon", hint: "Use the Sky Blaster to breathe fire" },
    "sky:whale": { label: "Sky Whale", hint: "Look where you want to go, hold jump to rise" },
    "sky:peter": { label: "Peter", hint: "Use the Sky Blaster to shoot starfire. Hold jump to climb" },
};
const WEAPONS = {
    "sky:fighter": { projectile: "sky:laser_bolt", cooldown: 6, speed: 3.2, up: 0.5, ahead: 3, twin: 1.4, sound: "firework.blast", pitch: 1.6 },
    "sky:dragon": { projectile: "sky:fireball", cooldown: 16, speed: 2.2, up: 1.3, ahead: 2.8, sound: "mob.ghast.fireball" },
    "sky:peter": { projectile: "sky:starfire", cooldown: 12, speed: 2.6, up: 3.4, ahead: 6.5, sound: "mob.blaze.shoot", pitch: 0.7 },
};
const HATCHLINGS = {
    "sky:dragon": {
        hatched: "§6A baby Fire Dragon hatched and chose you! §fFeed it cooked meat to help it grow (about 10 meals).",
        grown: "§6Your dragon is all grown up! §fClimb on and fly. Use the Sky Blaster to breathe fire.",
    },
    "sky:peter": {
        hatched: "§bPeter hatched and chose you! §fFeed him cooked meat to help him grow (about 20 meals).",
        grown: "§bPeter is all grown up! §fClimb on (3 seats) and use the Sky Blaster to shoot starfire.",
    },
};
const FUEL_ITEMS = "coal, charcoal or blaze powder";
const DIMENSIONS = ["overworld", "nether", "the_end"];
const RING_RADIUS = 4;
const RING_HIT_RADIUS = 4.6;
const MAX_RINGS = 40;
const RACE_TIMEOUT_TICKS = 20 * 60 * 10;
// ---------------------------------------------------------------- small helpers
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const norm = (a) => {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
};
/** Horizontal forward vector for a Minecraft yaw (degrees). */
const forwardOf = (yaw) => {
    const r = (yaw * Math.PI) / 180;
    return { x: -Math.sin(r), y: 0, z: Math.cos(r) };
};
function valid(e) {
    try {
        return !!e && e.isValid;
    }
    catch {
        return false;
    }
}
function tryRun(fn) {
    try {
        return fn();
    }
    catch {
        return undefined;
    }
}
function getRiders(e) {
    const r = e.getComponent("minecraft:rideable");
    return r ? tryRun(() => r.getRiders()) ?? [] : [];
}
function ridingOn(p) {
    const c = p.getComponent("minecraft:riding");
    return c ? tryRun(() => c.entityRidingOn) : undefined;
}
function isCreative(p) {
    return p.getGameMode() === GameMode.Creative;
}
/** Remove one of `typeId` from the player's selected slot (no-op in creative). */
function consumeHeld(p, typeId) {
    if (isCreative(p))
        return;
    const inv = p.getComponent("minecraft:inventory");
    const c = inv?.container;
    if (!c)
        return;
    const slot = p.selectedSlotIndex;
    const stack = c.getItem(slot);
    if (!stack || stack.typeId !== typeId)
        return;
    if (stack.amount <= 1)
        c.setItem(slot, undefined);
    else {
        stack.amount -= 1;
        c.setItem(slot, stack);
    }
}
function fuelBar(fuel) {
    const filled = Math.round(fuel / 10);
    const color = fuel > 50 ? "§a" : fuel > 20 ? "§e" : "§c";
    return `${color}${"|".repeat(filled)}§8${"|".repeat(10 - filled)}§r`;
}
function forEachFlyer(fn) {
    for (const id of DIMENSIONS) {
        const dim = tryRun(() => world.getDimension(id));
        if (!dim)
            continue;
        for (const e of tryRun(() => dim.getEntities({ families: ["sky_flyer"] })) ?? [])
            fn(e);
    }
}
// ---------------------------------------------------------------- flight + fuel
const burnProgress = new Map();
const mountedAt = new Map();
const lastVehicle = new Map(); // player id -> flyer typeId they were riding
function flightTick() {
    const now = system.currentTick;
    forEachFlyer((e) => {
        const cfg = FLYERS[e.typeId];
        if (!cfg)
            return;
        const players = getRiders(e).filter((r) => r instanceof Player);
        const controlled = players.length > 0;
        const usesFuel = cfg.burnTicks !== undefined;
        let fuel = usesFuel ? Number(e.getProperty("sky:fuel") ?? 0) : 100;
        const flying = e.getProperty("sky:flying") === true;
        // burn fuel while flying with a pilot
        if (usesFuel && flying && controlled) {
            const p = (burnProgress.get(e.id) ?? 0) + 5;
            if (p >= cfg.burnTicks) {
                fuel = Math.max(0, fuel - 1);
                e.setProperty("sky:fuel", fuel);
                burnProgress.set(e.id, 0);
                if (fuel === 0) {
                    for (const pl of players) {
                        pl.onScreenDisplay.setTitle("§cOut of fuel!", {
                            subtitle: `Gliding down... feed it ${FUEL_ITEMS}`,
                            fadeInDuration: 2, stayDuration: 50, fadeOutDuration: 10,
                        });
                        tryRun(() => pl.addEffect("slow_falling", 200, { showParticles: false }));
                    }
                    tryRun(() => e.addEffect("slow_falling", 200, { showParticles: false }));
                }
            }
            else
                burnProgress.set(e.id, p);
        }
        const wantFly = controlled && fuel > 0;
        if (wantFly !== flying) {
            tryRun(() => e.triggerEvent(wantFly ? "sky:take_off" : "sky:land"));
            if (wantFly && e.typeId === "sky:peter")
                tryRun(() => e.dimension.playSound("mob.ravager.roar", e.location, { pitch: 0.7 }));
        }
        // HUD for riders (racers get the race HUD instead)
        for (const pl of players) {
            if (!mountedAt.has(pl.id))
                mountedAt.set(pl.id, now);
            const fresh = now - (mountedAt.get(pl.id) ?? now) < 80;
            if (races.has(pl.id) || (!usesFuel && !fresh))
                continue;
            const fuelText = usesFuel ? `  Fuel ${fuelBar(fuel)} ${fuel}%` : "";
            const tip = fresh ? `\n§7${cfg.hint}` : usesFuel && fuel <= 20 ? `\n§7Low fuel: refuel with ${FUEL_ITEMS}` : "";
            pl.onScreenDisplay.setActionBar(`§l${cfg.label}§r${fuelText}${tip}`);
        }
    });
    // dismount safety + mount tracking
    for (const p of world.getAllPlayers()) {
        const v = ridingOn(p);
        const onFlyer = valid(v) && FLYERS[v.typeId] !== undefined;
        if (onFlyer) {
            lastVehicle.set(p.id, v.typeId);
        }
        else {
            if (lastVehicle.has(p.id) && !p.isOnGround) {
                tryRun(() => p.addEffect("slow_falling", 160, { showParticles: false }));
            }
            lastVehicle.delete(p.id);
            mountedAt.delete(p.id);
        }
    }
}
// refuel feedback (the refuel itself is data-driven in the entity file)
world.afterEvents.dataDrivenEntityTrigger.subscribe((ev) => {
    const e = ev.entity;
    if (ev.eventId === "sky:refuel_small" || ev.eventId === "sky:refuel_big") {
        system.run(() => {
            if (!valid(e))
                return;
            const fuel = Number(e.getProperty("sky:fuel") ?? 0);
            tryRun(() => e.dimension.playSound("random.orb", e.location));
            for (const p of e.dimension.getPlayers({ location: e.location, maxDistance: 8 })) {
                p.onScreenDisplay.setActionBar(`§aRefueled!§r Fuel ${fuelBar(fuel)} ${fuel}%`);
            }
        });
    }
    else if (ev.eventId === "sky:grow_up" && HATCHLINGS[e.typeId]) {
        system.run(() => {
            if (!valid(e))
                return;
            const t = e.getComponent("minecraft:tameable");
            const owner = tryRun(() => t?.tamedToPlayer);
            const msg = HATCHLINGS[e.typeId].grown;
            if (owner)
                owner.sendMessage(msg);
            tryRun(() => e.dimension.playSound("random.levelup", e.location));
        });
    }
});
// ---------------------------------------------------------------- Sky Blaster
const lastShot = new Map();
function shoot(dim, type, from, dir, speed, owner) {
    const proj = tryRun(() => dim.spawnEntity(type, from));
    if (!proj)
        return;
    const comp = proj.getComponent("minecraft:projectile");
    if (comp) {
        comp.owner = owner;
        comp.shoot(scale(dir, speed));
    }
    else {
        proj.applyImpulse(scale(dir, speed));
    }
}
function fireBlaster(p) {
    const v = ridingOn(p);
    const w = valid(v) ? WEAPONS[v.typeId] : undefined;
    if (!valid(v) || !w) {
        p.onScreenDisplay.setActionBar("§eRide a Sky Fighter, a grown Fire Dragon or a grown Peter to fire!");
        return;
    }
    const now = system.currentTick;
    if (now - (lastShot.get(p.id) ?? -999) < w.cooldown)
        return;
    lastShot.set(p.id, now);
    const dir = norm(p.getViewDirection());
    const dim = v.dimension;
    const base = add(add(v.location, { x: 0, y: w.up, z: 0 }), scale(dir, w.ahead));
    if (w.twin) {
        const right = norm({ x: -dir.z, y: 0, z: dir.x });
        for (const side of [-w.twin, w.twin])
            shoot(dim, w.projectile, add(base, scale(right, side)), dir, w.speed, p);
    }
    else {
        shoot(dim, w.projectile, base, dir, w.speed, p);
    }
    dim.playSound(w.sound, v.location, { volume: 0.8, pitch: w.pitch ?? 1 });
}
// ---------------------------------------------------------------- Cargo Blimp hold
const CRATE_PROP = "sky:crate";
const BLIMP_PROP = "sky:blimp";
const missingSince = new Map();
function crateAnchor(blimp) {
    const back = scale(forwardOf(blimp.getRotation().y), -0.55);
    return add(add(blimp.location, back), { x: 0, y: 0.13, z: 0 });
}
function spawnCrate(blimp) {
    const crate = tryRun(() => blimp.dimension.spawnEntity("sky:cargo_crate", crateAnchor(blimp)));
    if (!crate)
        return;
    blimp.setDynamicProperty(CRATE_PROP, crate.id);
    crate.setDynamicProperty(BLIMP_PROP, blimp.id);
    missingSince.delete(blimp.id);
}
function crateTick() {
    const now = system.currentTick;
    for (const id of DIMENSIONS) {
        const dim = tryRun(() => world.getDimension(id));
        if (!dim)
            continue;
        for (const blimp of tryRun(() => dim.getEntities({ type: "sky:blimp" })) ?? []) {
            const crateId = blimp.getDynamicProperty(CRATE_PROP);
            const crate = crateId ? world.getEntity(crateId) : undefined;
            if (valid(crate)) {
                missingSince.delete(blimp.id);
                tryRun(() => crate.teleport(crateAnchor(blimp), { rotation: { x: 0, y: blimp.getRotation().y } }));
            }
            else {
                // new blimp, or its hold was destroyed: give it a fresh one after a short wait
                const since = missingSince.get(blimp.id) ?? now;
                missingSince.set(blimp.id, since);
                if (!crateId || now - since > 200)
                    spawnCrate(blimp);
            }
        }
    }
}
function crateOrphanCheck() {
    for (const id of DIMENSIONS) {
        const dim = tryRun(() => world.getDimension(id));
        if (!dim)
            continue;
        for (const crate of tryRun(() => dim.getEntities({ type: "sky:cargo_crate" })) ?? []) {
            const blimpId = crate.getDynamicProperty(BLIMP_PROP);
            const blimp = blimpId ? world.getEntity(blimpId) : undefined;
            if (!valid(blimp) || blimp.getDynamicProperty(CRATE_PROP) !== crate.id) {
                tryRun(() => crate.triggerEvent("sky:orphan"));
            }
        }
    }
}
function dumpCrate(crate) {
    const inv = crate.getComponent("minecraft:inventory");
    const c = inv?.container;
    if (c) {
        for (let i = 0; i < c.size; i++) {
            const it = c.getItem(i);
            if (it)
                crate.dimension.spawnItem(it, crate.location);
        }
        c.clearAll();
    }
    crate.remove();
}
// ---------------------------------------------------------------- pack up (sneak + hit)
world.afterEvents.entityHitEntity.subscribe(({ damagingEntity: p, hitEntity: v }) => {
    if (!(p instanceof Player) || !p.isSneaking || !valid(v))
        return;
    const cfg = FLYERS[v.typeId];
    if (!cfg?.kit)
        return;
    if (getRiders(v).length > 0) {
        p.onScreenDisplay.setActionBar("§eEveryone needs to get off before you pack it up.");
        return;
    }
    const loc = v.location;
    const dim = v.dimension;
    if (v.typeId === "sky:blimp") {
        const crate = world.getEntity(v.getDynamicProperty(CRATE_PROP) ?? "");
        if (valid(crate))
            dumpCrate(crate);
    }
    v.remove();
    dim.spawnItem(new ItemStack(cfg.kit, 1), loc);
    dim.playSound("random.pop", loc);
    p.onScreenDisplay.setActionBar(`§aPacked up the ${cfg.label}.`);
});
// ---------------------------------------------------------------- dragon hatching
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    const info = HATCHLINGS[entity.typeId];
    if (!info)
        return;
    system.runTimeout(() => {
        if (!valid(entity) || !entity.getComponent("minecraft:is_baby"))
            return;
        const t = entity.getComponent("minecraft:tameable");
        if (!t || t.isTamed)
            return;
        const near = entity.dimension.getPlayers({ location: entity.location, maxDistance: 24, closest: 1 })[0];
        if (!near)
            return;
        tryRun(() => t.tame(near));
        if (!entity.getComponent("minecraft:is_tamed"))
            tryRun(() => entity.triggerEvent("sky:on_tame"));
        near.sendMessage(info.hatched);
        entity.dimension.playSound("random.levelup", entity.location, { pitch: 1.4 });
    }, 3);
});
const races = new Map();
function getRings() {
    const raw = world.getDynamicProperty("sky:rings");
    return raw ? (tryRun(() => JSON.parse(raw)) ?? []) : [];
}
function setRings(rings) {
    world.setDynamicProperty("sky:rings", JSON.stringify(rings));
}
function courseId(rings) {
    return rings.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)}`).join(";");
}
function ringBlocks(r) {
    const fwd = forwardOf(r.yaw);
    const right = { x: -fwd.z, y: 0, z: fwd.x };
    const seen = new Set();
    const out = [];
    for (let a = 0; a < 360; a += 5) {
        const t = (a * Math.PI) / 180;
        const p = {
            x: Math.floor(r.x + right.x * RING_RADIUS * Math.cos(t)),
            y: Math.floor(r.y + RING_RADIUS * Math.sin(t)),
            z: Math.floor(r.z + right.z * RING_RADIUS * Math.cos(t)),
        };
        const k = `${p.x},${p.y},${p.z}`;
        if (!seen.has(k)) {
            seen.add(k);
            out.push(p);
        }
    }
    return out;
}
function placeRing(p) {
    const rings = getRings();
    if (p.isSneaking) {
        const last = rings.pop();
        if (!last) {
            p.sendMessage("§eThere are no race rings to remove.");
            return;
        }
        const dim = world.getDimension(last.dim);
        for (const b of ringBlocks(last)) {
            const block = tryRun(() => dim.getBlock(b));
            if (block && (block.typeId === "minecraft:glowstone" || block.typeId === "minecraft:sea_lantern"))
                tryRun(() => block.setType("minecraft:air"));
        }
        setRings(rings);
        p.sendMessage(`§eRemoved ring #${rings.length + 1}. The course now has ${rings.length} ring(s).`);
        return;
    }
    if (rings.length >= MAX_RINGS) {
        p.sendMessage(`§cThe course already has ${MAX_RINGS} rings. Sneak + use a Race Ring to remove the last one.`);
        return;
    }
    const yaw = p.getRotation().y;
    const fwd = forwardOf(yaw);
    const head = p.getHeadLocation();
    const c = add(head, scale(fwd, 7));
    const ring = { x: c.x, y: c.y, z: c.z, yaw, dim: p.dimension.id };
    let placed = 0;
    ringBlocks(ring).forEach((b, i) => {
        const block = tryRun(() => p.dimension.getBlock(b));
        if (block && block.isAir) {
            tryRun(() => block.setType(i % 2 ? "minecraft:sea_lantern" : "minecraft:glowstone"));
            placed++;
        }
    });
    if (placed === 0) {
        p.sendMessage("§cNo room for a ring there. Face open sky and try again.");
        return;
    }
    rings.push(ring);
    setRings(rings);
    consumeHeld(p, "sky:race_ring");
    p.dimension.playSound("note.pling", c, { pitch: 1 + rings.length * 0.05 });
    p.sendMessage(`§6Ring #${rings.length} placed!§r Fly through the rings in order. Use the §lRace Flag§r to start a race.`);
}
function getBoard(course) {
    const raw = world.getDynamicProperty("sky:board");
    const all = raw ? (tryRun(() => JSON.parse(raw)) ?? null) : null;
    return all && all.course === course ? all.records : [];
}
function saveBoard(course, records) {
    world.setDynamicProperty("sky:board", JSON.stringify({ course, records }));
}
function showBoard(p) {
    const rings = getRings();
    const board = getBoard(courseId(rings));
    if (!rings.length) {
        p.sendMessage("§eNo course yet. Place Race Rings first.");
        return;
    }
    if (!board.length) {
        p.sendMessage(`§6Sky Race (${rings.length} rings):§r no laps yet. Be the first!`);
        return;
    }
    const lines = board.map((r, i) => `§e${i + 1}. §f${r.name} §7- §a${r.time.toFixed(2)}s`);
    p.sendMessage([`§6Sky Race best laps (${rings.length} rings):`, ...lines].join("\n"));
}
function startRace(p) {
    if (p.isSneaking)
        return showBoard(p);
    const rings = getRings();
    if (!rings.length) {
        p.sendMessage("§eBuild a course first: use Race Rings to place glowing checkpoints in the sky.");
        return;
    }
    const course = courseId(rings);
    races.delete(p.id);
    const show = (t, sub = "") => p.onScreenDisplay.setTitle(t, { subtitle: sub, fadeInDuration: 0, stayDuration: 18, fadeOutDuration: 4 });
    show("§e3", `${rings.length} rings. Go through them in order!`);
    p.playSound("note.hat");
    system.runTimeout(() => (show("§e2"), p.playSound("note.hat")), 20);
    system.runTimeout(() => (show("§e1"), p.playSound("note.hat")), 40);
    system.runTimeout(() => {
        if (!p.isValid)
            return;
        show("§aGO!");
        p.playSound("note.pling", { pitch: 2 });
        races.set(p.id, { start: system.currentTick, next: 0, course });
    }, 60);
}
function raceTick() {
    if (!races.size)
        return;
    const rings = getRings();
    const course = courseId(rings);
    const now = system.currentTick;
    for (const p of world.getAllPlayers()) {
        const st = races.get(p.id);
        if (!st)
            continue;
        if (st.course !== course || now - st.start > RACE_TIMEOUT_TICKS) {
            races.delete(p.id);
            p.sendMessage("§eRace cancelled (the course changed or time ran out).");
            continue;
        }
        const ring = rings[st.next];
        const t = (now - st.start) / 20;
        const loc = add(p.location, { x: 0, y: 0.9, z: 0 });
        if (p.dimension.id === ring.dim && dist(loc, ring) <= RING_HIT_RADIUS) {
            st.next++;
            if (st.next >= rings.length) {
                races.delete(p.id);
                finishRace(p, course, t);
                continue;
            }
            p.playSound("note.pling", { pitch: 0.8 + (st.next / rings.length) * 1.2 });
        }
        p.onScreenDisplay.setActionBar(`§6Ring ${Math.min(st.next + 1, rings.length)}/${rings.length}  §f${t.toFixed(1)}s`);
    }
}
function finishRace(p, course, time) {
    const board = getBoard(course);
    const prev = board.find((r) => r.name === p.name);
    const isPB = !prev || time < prev.time;
    const updated = isPB ? [...board.filter((r) => r.name !== p.name), { name: p.name, time }] : board;
    updated.sort((a, b) => a.time - b.time);
    const top = updated.slice(0, 10);
    saveBoard(course, top);
    const rank = top.findIndex((r) => r.name === p.name) + 1;
    p.onScreenDisplay.setTitle("§aFinished!", {
        subtitle: `${time.toFixed(2)}s${isPB ? "  §6New personal best!" : ""}`,
        fadeInDuration: 0, stayDuration: 60, fadeOutDuration: 10,
    });
    p.playSound("random.levelup");
    world.sendMessage(`§6${p.name}§r finished the Sky Race in §a${time.toFixed(2)}s§r${rank === 1 && isPB ? " §d- NEW COURSE RECORD!" : ""}`);
}
// ---------------------------------------------------------------- island seeds
const BLOCKS = {
    grass: "minecraft:grass_block",
    dirt: "minecraft:dirt",
    stone: "minecraft:stone",
    andesite: "minecraft:andesite",
    coal: "minecraft:coal_ore",
    iron: "minecraft:iron_ore",
    log: "minecraft:oak_log",
    leaves: "minecraft:oak_leaves",
    flowers: ["minecraft:short_grass", "minecraft:short_grass", "minecraft:poppy", "minecraft:dandelion", "minecraft:cornflower"],
};
function makeNoise(seed) {
    return (x, z) => Math.sin(x * 0.9 + seed) * 0.6 + Math.sin(z * 1.1 + seed * 1.7) * 0.6 + Math.sin((x + z) * 0.5 + seed * 0.3) * 0.5;
}
function* islandJob(dim, cx, top, cz, p) {
    const seed = Math.random() * 1000;
    const noise = makeNoise(seed);
    const r = 6 + Math.floor(Math.random() * 5);
    let n = 0;
    const set = (x, y, z, type, onlyAir = true) => {
        const b = tryRun(() => dim.getBlock({ x, y, z }));
        if (!b || (onlyAir && !b.isAir))
            return;
        tryRun(() => b.setType(type));
    };
    for (let dx = -r - 2; dx <= r + 2; dx++) {
        for (let dz = -r - 2; dz <= r + 2; dz++) {
            const d = Math.hypot(dx, dz);
            const edge = r + noise(dx, dz) * 1.5;
            if (d > edge)
                continue;
            const depth = Math.max(2, Math.round(2 + (edge - d) * 1.4 + noise(dz, dx) * 1.2));
            for (let dy = 0; dy <= depth; dy++) {
                const y = top - dy;
                let type = BLOCKS.stone;
                if (dy === 0)
                    type = BLOCKS.grass;
                else if (dy <= 2)
                    type = BLOCKS.dirt;
                else {
                    const roll = Math.random();
                    type = roll < 0.05 ? BLOCKS.coal : roll < 0.08 ? BLOCKS.iron : roll < 0.2 ? BLOCKS.andesite : BLOCKS.stone;
                }
                set(cx + dx, y, cz + dz, type);
                if (++n % 48 === 0)
                    yield;
            }
            if (Math.random() < 0.18 && d < edge - 1) {
                set(cx + dx, top + 1, cz + dz, BLOCKS.flowers[Math.floor(Math.random() * BLOCKS.flowers.length)]);
            }
        }
    }
    // a tree, off to the side so it doesn't trap the player
    const ang = Math.random() * Math.PI * 2;
    const tx = cx + Math.round(Math.cos(ang) * (r / 2));
    const tz = cz + Math.round(Math.sin(ang) * (r / 2));
    const h = 4 + Math.floor(Math.random() * 2);
    for (let y = 1; y <= h; y++)
        set(tx, top + y, tz, BLOCKS.log, false);
    for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++)
            for (let y = h - 1; y <= h + 1; y++) {
                if (Math.abs(x) + Math.abs(z) + Math.max(0, y - h) * 2 > 3)
                    continue;
                set(tx + x, top + y, tz + z, BLOCKS.leaves);
            }
    set(tx, top + h + 1, tz, BLOCKS.leaves);
    yield;
    if (p.isValid) {
        p.sendMessage("§aA floating island grew beneath you!");
        tryRun(() => dim.playSound("random.levelup", { x: cx, y: top, z: cz }, { pitch: 0.8 }));
    }
}
/** Checks for 8+ blocks of open air under the player. Returns the block spot, or undefined (and tells them why). */
function skySpot(p, seedName) {
    const dim = p.dimension;
    const loc = p.location;
    const x = Math.floor(loc.x);
    const z = Math.floor(loc.z);
    const y = Math.floor(loc.y);
    for (let dy = 1; dy <= 8; dy++) {
        const b = tryRun(() => dim.getBlock({ x, y: y - dy, z }));
        if (!b) {
            p.sendMessage("§cThat spot isn't loaded yet. Try again in a moment.");
            return undefined;
        }
        if (!b.isAir) {
            p.sendMessage(`§eFly higher first! ${seedName}s need at least 8 blocks of open sky below you.`);
            return undefined;
        }
    }
    if (y - 4 < dim.heightRange.min + 20 || y + 8 > dim.heightRange.max) {
        p.sendMessage("§eToo close to the edge of the world for that here.");
        return undefined;
    }
    return { x, y, z };
}
function plantIsland(p) {
    const dim = p.dimension;
    const spot = skySpot(p, "Island Seed");
    if (!spot)
        return;
    const { x, y, z } = spot;
    consumeHeld(p, "sky:island_seed");
    p.onScreenDisplay.setActionBar("§aGrowing island...");
    tryRun(() => p.addEffect("slow_falling", 100, { showParticles: false }));
    system.runJob(islandJob(dim, x, y - 4, z, p));
}
// ---------------------------------------------------------------- clouds: shared building helpers
const CLOUD = "sky:cloud";
const PORTAL = "sky:cloud_portal";
const OVERWORLD = "minecraft:overworld";
function blockAt(dim, loc) {
    return tryRun(() => dim.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) }));
}
/** Places one block. Returns false only when its chunk isn't loaded yet, so jobs can wait and retry. */
function placeBlock(dim, x, y, z, type, onlyAir = true) {
    let b;
    try {
        b = dim.getBlock({ x, y, z });
    }
    catch {
        return false;
    }
    if (!b)
        return false;
    if (onlyAir && !b.isAir)
        return true;
    tryRun(() => b.setType(type));
    return true;
}
/** Job step: places [x, y, z, type, onlyAir?] entries, waiting (up to ~20 s per block) for chunks to load. */
function* placeAll(dim, list, state) {
    let n = 0;
    for (const [x, y, z, type, onlyAir] of list) {
        const since = system.currentTick;
        while (!placeBlock(dim, x, y, z, type, onlyAir !== false)) {
            if (system.currentTick - since > 400) {
                state.failed = true;
                return;
            }
            yield;
        }
        if (++n % 64 === 0)
            yield;
    }
}
/** A puffy ball of cloud (squash < 1 flattens it). */
function puff(list, cx, cy, cz, rad, squash = 0.75) {
    const ry = Math.max(1, Math.round(rad * squash));
    for (let dx = -rad; dx <= rad; dx++)
        for (let dz = -rad; dz <= rad; dz++)
            for (let dy = -ry; dy <= ry; dy++) {
                const d = (dx * dx) / (rad * rad) + (dy * dy) / (ry * ry) + (dz * dz) / (rad * rad);
                if (d <= 1 + Math.random() * 0.15)
                    list.push([cx + dx, cy + dy, cz + dz, CLOUD]);
            }
}
// ---------------------------------------------------------------- clouds: bounce + soft landing
const lastVy = new Map();
function cloudTick() {
    for (const p of world.getAllPlayers()) {
        if (valid(ridingOn(p))) {
            lastVy.delete(p.id);
            continue;
        }
        const dim = p.dimension;
        const loc = p.location;
        const v = p.getVelocity();
        // soft landing: no fall damage when you drop onto a cloud
        if (v.y < -0.4) {
            for (let d = 0; d <= 5; d++) {
                const b = blockAt(dim, { x: loc.x, y: loc.y - 0.3 - d, z: loc.z });
                if (!b)
                    break;
                if (b.typeId === CLOUD) {
                    tryRun(() => p.addEffect("resistance", 6, { amplifier: 4, showParticles: false }));
                    break;
                }
                if (!b.isAir)
                    break;
            }
        }
        const prev = lastVy.get(p.id) ?? 0;
        lastVy.set(p.id, v.y);
        const under = blockAt(dim, { x: loc.x, y: loc.y - 0.3, z: loc.z });
        if (under?.typeId !== CLOUD || p.isSneaking)
            continue;
        if (prev < -0.42 && v.y <= 0.05) {
            // landed from a fall: bounce back up (a little lower each time, or higher if you hold jump)
            const up = Math.min(1.5, -prev * 0.85 + (p.isJumping ? 0.25 : 0));
            tryRun(() => p.applyKnockback({ x: v.x, z: v.z }, up));
            tryRun(() => dim.playSound("mob.slime.big", loc, { volume: 0.6, pitch: 1.5 }));
            lastVy.set(p.id, up);
        }
        else if (system.currentTick % 10 === 0) {
            tryRun(() => p.addEffect("jump_boost", 16, { amplifier: 1, showParticles: false }));
        }
    }
}
// ---------------------------------------------------------------- clouds: Cloud Seed
function* cloudJob(dim, cx, top, cz, p) {
    const list = [];
    const noise = makeNoise(Math.random() * 1000);
    const r = 6 + Math.floor(Math.random() * 5);
    for (let dx = -r - 2; dx <= r + 2; dx++) {
        for (let dz = -r - 2; dz <= r + 2; dz++) {
            const d = Math.hypot(dx, dz);
            const edge = r + noise(dx * 0.5, dz * 0.5) * 1.2;
            if (d > edge)
                continue;
            const depth = Math.max(1, Math.round(1 + (edge - d) * 0.6 + noise(dz, dx) * 0.8));
            for (let dy = 0; dy <= depth; dy++)
                list.push([cx + dx, top - dy, cz + dz, CLOUD]);
        }
    }
    // bumps on top to bounce on
    const bumps = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < bumps; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * r * 0.75;
        puff(list, cx + Math.round(Math.cos(a) * d), top + 1, cz + Math.round(Math.sin(a) * d), 2 + Math.floor(Math.random() * 3), 0.6);
    }
    const state = { failed: false };
    yield* placeAll(dim, list, state);
    if (p.isValid) {
        p.sendMessage("§fA puffy cloud island formed beneath you! §7Jump on it to bounce. Sneak to stop bouncing.");
        tryRun(() => dim.playSound("random.levelup", { x: cx, y: top, z: cz }, { pitch: 1.3 }));
    }
}
function plantCloud(p) {
    const spot = skySpot(p, "Cloud Seed");
    if (!spot)
        return;
    consumeHeld(p, "sky:cloud_seed");
    p.onScreenDisplay.setActionBar("§fA cloud is forming...");
    tryRun(() => p.addEffect("slow_falling", 100, { showParticles: false }));
    system.runJob(cloudJob(p.dimension, spot.x, spot.y - 3, spot.z, p));
}
// ---------------------------------------------------------------- Cloud Realm (with the hidden castle)
const REALM_Y = 288; // above everything else in the world (build limit is 320)
const REALM_NORTH = 400; // blocks north of world spawn
const REALM_CHEST = { dx: 0, dy: 1, dz: -14 }; // treasure chest, relative to the realm center
let realmCache;
let realmBuilding = false;
function getRealm() {
    if (realmCache)
        return realmCache;
    const raw = world.getDynamicProperty("sky:realm");
    let r = raw ? tryRun(() => JSON.parse(raw)) : undefined;
    if (!r) {
        const s = world.getDefaultSpawnLocation();
        r = { x: Math.floor(s.x), y: REALM_Y, z: Math.floor(s.z) - REALM_NORTH, built: false };
        world.setDynamicProperty("sky:realm", JSON.stringify(r));
    }
    realmCache = r;
    return r;
}
function saveRealm(r) {
    realmCache = r;
    world.setDynamicProperty("sky:realm", JSON.stringify(r));
}
function inRealm(dim, loc) {
    const r = getRealm();
    return dim.id === OVERWORLD && Math.abs(loc.x - r.x) < 90 && Math.abs(loc.z - r.z) < 90 && loc.y > r.y - 70;
}
const realmArrival = (r) => ({ x: r.x + 0.5, y: r.y + 1, z: r.z + 22.5 });
/** Portal frame: 4 wide x 5 tall of cloud with a 2 x 3 glowing middle. `base` is the bottom-left middle cell. */
function portalBlocks(base, right) {
    const out = [];
    for (let a = -1; a <= 2; a++)
        for (let h = -1; h <= 3; h++) {
            const frame = a === -1 || a === 2 || h === -1 || h === 3;
            out.push([base.x + right.x * a, base.y + h, base.z + right.z * a, frame ? CLOUD : PORTAL]);
        }
    return out;
}
function realmPlateau(r) {
    const out = [];
    const noise = makeNoise((r.x * 0.13 + r.z * 0.07) % 1000);
    for (let dx = -33; dx <= 33; dx++)
        for (let dz = -37; dz <= 37; dz++) {
            const e = Math.hypot(dx / 30, dz / 34);
            const edge = 1 + noise(dx * 0.3, dz * 0.3) * 0.05;
            if (e > edge)
                continue;
            const depth = Math.max(1, 1 + Math.round((edge - e) * 7 + noise(dz * 0.4, dx * 0.4) * 1.2));
            for (let dy = 0; dy <= depth; dy++)
                out.push([r.x + dx, r.y - dy, r.z + dz, CLOUD]);
        }
    // puffs around the rim and little clouds floating overhead
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + Math.random() * 0.2;
        if (Math.sin(a) > 0.9)
            continue; // keep the view past the landing pad open
        puff(out, r.x + Math.round(Math.cos(a) * 27), r.y + 1, r.z + Math.round(Math.sin(a) * 31), 2 + Math.floor(Math.random() * 2));
    }
    for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 30 + Math.random() * 20;
        puff(out, r.x + Math.round(Math.cos(a) * d), r.y + 6 + Math.floor(Math.random() * 14), r.z + Math.round(Math.sin(a) * d), 2 + Math.floor(Math.random() * 3), 0.5);
    }
    return out;
}
/** The big cloud dome that hides the castle, with a walk-in tunnel on the south side. */
function realmDome(r) {
    const out = [];
    const cx = r.x, cz = r.z - 8, R = 19;
    const noise = makeNoise(42);
    for (let dx = -R - 2; dx <= R + 2; dx++)
        for (let dz = -R - 2; dz <= R + 2; dz++)
            for (let dy = 1; dy <= R + 2; dy++) {
                const d = Math.hypot(dx, dy, dz);
                const rad = R + noise(dx * 0.35 + dy * 0.2, dz * 0.35 - dy * 0.2) * 0.9;
                if (d > rad || d < rad - 2.2)
                    continue;
                if (dz > 0 && Math.abs(dx) <= 1 && dy <= 4)
                    continue; // the doorway
                out.push([cx + dx, r.y + dy, cz + dz, CLOUD]);
            }
    return out;
}
function realmCastle(r) {
    const out = [];
    const cx = r.x, cz = r.z - 8, y0 = r.y;
    const Q = "minecraft:quartz_block", QB = "minecraft:quartz_bricks", QP = "minecraft:quartz_pillar";
    const GLASS = "minecraft:light_blue_stained_glass", LAMP = "minecraft:sea_lantern";
    for (let dx = -7; dx <= 7; dx++)
        for (let dz = -7; dz <= 7; dz++) {
            const x = cx + dx, z = cz + dz;
            out.push([x, y0, z, dx % 4 === 0 && dz % 4 === 0 ? LAMP : Q]);
            const tower = Math.abs(dx) >= 6 && Math.abs(dz) >= 6;
            const wall = Math.abs(dx) === 7 || Math.abs(dz) === 7;
            if (tower) {
                for (let y = 1; y <= 11; y++)
                    out.push([x, y0 + y, z, QP]);
                if ((dx + dz) % 2 === 0)
                    out.push([x, y0 + 12, z, QB]);
            }
            else if (wall) {
                const along = Math.abs(dx) === 7 ? dz : dx;
                for (let y = 1; y <= 7; y++) {
                    if (dz === 7 && Math.abs(dx) <= 1 && y <= 4)
                        continue; // the gate
                    let t = QB;
                    if ((y === 3 || y === 4) && along % 3 === 0)
                        t = GLASS;
                    else if (y === 6 && Math.abs(along) % 4 === 2)
                        t = LAMP;
                    out.push([x, y0 + y, z, t]);
                }
                if ((dx + dz) % 2 === 0)
                    out.push([x, y0 + 8, z, QB]);
            }
            else {
                out.push([x, y0 + 7, z, dx % 4 === 0 && dz % 4 === 0 ? LAMP : Q]); // roof
                if (dx === 0 && dz >= -5)
                    out.push([x, y0 + 1, z, "minecraft:light_blue_carpet"]);
            }
        }
    // treasure corner at the back: chest between two gold blocks
    out.push([cx - 1, y0 + 1, cz - 6, "minecraft:gold_block"]);
    out.push([cx + 1, y0 + 1, cz - 6, "minecraft:gold_block"]);
    out.push([r.x + REALM_CHEST.dx, r.y + REALM_CHEST.dy, r.z + REALM_CHEST.dz, "minecraft:chest"]);
    return out;
}
function fillTreasure(dim, r) {
    const b = blockAt(dim, { x: r.x + REALM_CHEST.dx, y: r.y + REALM_CHEST.dy, z: r.z + REALM_CHEST.dz });
    const c = tryRun(() => b?.getComponent("minecraft:inventory")?.container);
    if (!c || c.emptySlotsCount < c.size)
        return;
    const loot = [
        ["minecraft:elytra", 1], ["minecraft:elytra", 1], ["minecraft:firework_rocket", 32],
        ["minecraft:diamond", 6], ["minecraft:golden_apple", 4], ["minecraft:blaze_powder", 6],
        ["sky:cloud_seed", 6], ["sky:island_seed", 8], ["sky:cloud", 32],
    ];
    loot.forEach(([type, n], i) => tryRun(() => c.setItem(i * 3, new ItemStack(type, n))));
}
function* realmJob(dim, r) {
    const state = { failed: false };
    // 1. landing pad first, so whoever just arrived has somewhere to stand
    const pad = [];
    for (let dx = -3; dx <= 3; dx++)
        for (let dz = 19; dz <= 25; dz++)
            pad.push([r.x + dx, r.y, r.z + dz, CLOUD]);
    yield* placeAll(dim, pad, state);
    for (const p of world.getAllPlayers()) {
        if (inRealm(p.dimension, p.location) && p.location.y < r.y + 0.5 && !valid(ridingOn(p)))
            tryRun(() => p.teleport(realmArrival(r), { rotation: { x: 0, y: 180 } }));
    }
    // 2. the way home, then the castle, the cloud hiding it, and the ground
    yield* placeAll(dim, portalBlocks({ x: r.x, y: r.y + 1, z: r.z + 26 }, { x: 1, z: 0 }), state);
    yield* placeAll(dim, realmCastle(r), state);
    yield* placeAll(dim, realmDome(r), state);
    yield* placeAll(dim, realmPlateau(r), state);
    fillTreasure(dim, r);
    tryRun(() => dim.runCommand("tickingarea remove sky_cloud_realm"));
    realmBuilding = false;
    if (state.failed) {
        world.sendMessage("§eThe Cloud Realm didn't finish forming. Go through a Cloud Portal again to finish it.");
        return;
    }
    saveRealm({ ...r, built: true });
    for (const p of world.getAllPlayers())
        if (inRealm(p.dimension, p.location))
            p.sendMessage("§bThe Cloud Realm has formed! §fSomething is hidden inside the big cloud...");
}
function prepareRealm(p, r) {
    if (r.built)
        return;
    if (realmBuilding) {
        p.sendMessage("§7The Cloud Realm is still forming...");
        return;
    }
    realmBuilding = true;
    const dim = world.getDimension("overworld");
    tryRun(() => dim.runCommand(`tickingarea add circle ${r.x} ${r.y} ${r.z} 4 sky_cloud_realm`));
    p.sendMessage("§bThe clouds are gathering...");
    system.runJob(realmJob(dim, r));
}
// ---------------------------------------------------------------- Cloud Portals
const portalArmed = new Map(); // must step out of a portal before another one can fire
function touchesPortal(e) {
    const l = e.location;
    return blockAt(e.dimension, l)?.typeId === PORTAL || blockAt(e.dimension, { x: l.x, y: l.y + 1, z: l.z })?.typeId === PORTAL;
}
function travel(p, vehicle, dest, rotY, title) {
    tryRun(() => p.addEffect("slow_falling", 200, { showParticles: false }));
    const opts = rotY === undefined ? {} : { rotation: { x: 0, y: rotY } };
    if (valid(vehicle)) {
        tryRun(() => vehicle.teleport(dest, opts));
        system.runTimeout(() => {
            if (p.isValid && !valid(ridingOn(p)))
                tryRun(() => p.teleport(dest, opts));
        }, 2);
    }
    else
        tryRun(() => p.teleport(dest, opts));
    p.onScreenDisplay.setTitle(title, { fadeInDuration: 5, stayDuration: 40, fadeOutDuration: 15 });
    system.runTimeout(() => p.isValid && tryRun(() => p.playSound("mob.endermen.portal", { pitch: 0.8 })), 3);
}
function usePortal(p, vehicle) {
    if (p.dimension.id !== OVERWORLD)
        return;
    const r = getRealm();
    if (inRealm(p.dimension, p.location)) {
        const raw = p.getDynamicProperty("sky:return");
        let back = raw ? tryRun(() => JSON.parse(raw)) : undefined;
        if (!back) {
            const s = world.getDefaultSpawnLocation();
            back = { x: s.x + 0.5, y: s.y > 300 || s.y < -60 ? 200 : s.y + 1, z: s.z + 0.5 };
        }
        travel(p, vehicle, back, undefined, "§bBack to the Sky Realms!");
    }
    else {
        const f = forwardOf(p.getRotation().y);
        const l = p.location;
        p.setDynamicProperty("sky:return", JSON.stringify({ x: l.x - f.x * 2, y: l.y, z: l.z - f.z * 2 }));
        travel(p, vehicle, realmArrival(r), 180, "§fThe §bCloud Realm");
        prepareRealm(p, r);
    }
}
function portalTick() {
    for (const p of world.getAllPlayers()) {
        const v = ridingOn(p);
        const hit = touchesPortal(p) || (valid(v) && touchesPortal(v));
        if (!hit) {
            portalArmed.set(p.id, true);
            continue;
        }
        if (portalArmed.get(p.id) === false)
            continue;
        portalArmed.set(p.id, false);
        usePortal(p, valid(v) ? v : undefined);
    }
}
/** Falling off the Cloud Realm (without wings or a ride) puts you back on the landing pad. */
function realmTick() {
    if (!world.getDynamicProperty("sky:realm"))
        return;
    const r = getRealm();
    for (const p of world.getAllPlayers()) {
        if (!inRealm(p.dimension, p.location) || p.location.y > r.y - 12)
            continue;
        if (valid(ridingOn(p)) || p.isGliding || p.isFlying)
            continue;
        tryRun(() => p.teleport(realmArrival(r), { rotation: { x: 0, y: 180 } }));
        tryRun(() => p.addEffect("slow_falling", 100, { showParticles: false }));
        p.sendMessage("§bThe clouds caught you! §fTo go home, walk into the portal behind the landing pad.");
    }
}
function buildPortal(p) {
    if (p.dimension.id !== OVERWORLD) {
        p.sendMessage("§eCloud Portals only work in the Overworld.");
        return;
    }
    if (inRealm(p.dimension, p.location)) {
        p.sendMessage("§eThe Cloud Realm already has a way home: the portal behind the landing pad.");
        return;
    }
    const f = forwardOf(p.getRotation().y);
    const fc = Math.abs(f.x) > Math.abs(f.z) ? { x: Math.sign(f.x), z: 0 } : { x: 0, z: Math.sign(f.z) };
    const right = { x: -fc.z, z: fc.x };
    const l = p.location;
    const base = { x: Math.floor(l.x) + fc.x * 3, y: Math.floor(l.y), z: Math.floor(l.z) + fc.z * 3 };
    const list = portalBlocks(base, right);
    for (const [x, y, z, type] of list) {
        if (type !== PORTAL)
            continue;
        const b = tryRun(() => p.dimension.getBlock({ x, y, z }));
        if (!b?.isAir) {
            p.sendMessage("§eA Cloud Portal needs open space 4 wide and 5 tall, 3 blocks in front of you.");
            return;
        }
    }
    consumeHeld(p, "sky:cloud_portal_kit");
    for (const [x, y, z, type] of list)
        placeBlock(p.dimension, x, y, z, type);
    portalArmed.set(p.id, false);
    p.dimension.playSound("block.end_portal.spawn", base, { volume: 0.5 });
    p.sendMessage("§bA Cloud Portal opened! §fWalk into it to go up to the secret Cloud Realm.");
}
// ---------------------------------------------------------------- item use router
const lastUse = new Map(); // stops one tap counting twice (tap in the air vs. tap on a block)
function useItem(p, typeId) {
    const now = system.currentTick;
    const key = `${p.id}|${typeId}`;
    if (now - (lastUse.get(key) ?? -99) < 5)
        return;
    lastUse.set(key, now);
    switch (typeId) {
        case "sky:blaster":
            return fireBlaster(p);
        case "sky:race_ring":
            return placeRing(p);
        case "sky:race_flag":
            return startRace(p);
        case "sky:island_seed":
            return plantIsland(p);
        case "sky:cloud_seed":
            return plantCloud(p);
        case "sky:cloud_portal_kit":
            return buildPortal(p);
    }
}
world.afterEvents.itemUse.subscribe(({ source: p, itemStack }) => useItem(p, itemStack.typeId));
world.afterEvents.playerInteractWithBlock.subscribe(({ player, itemStack, isFirstEvent }) => {
    const t = itemStack?.typeId;
    if (isFirstEvent && (t === "sky:cloud_portal_kit" || t === "sky:cloud_seed"))
        useItem(player, t);
});
// ---------------------------------------------------------------- welcome + loops
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
    if (!initialSpawn)
        return;
    system.runTimeout(() => {
        if (!player.isValid)
            return;
        player.sendMessage("§b§lSky Realms§r is on! Craft kits or grab them from the creative menu. " +
            "§7Refuel vehicles with coal. Sneak + hit a vehicle to pack it up.");
    }, 60);
});
world.afterEvents.worldLoad.subscribe(() => {
    system.runInterval(() => tryRun(flightTick), 5);
    system.runInterval(() => tryRun(crateTick), 1);
    system.runInterval(() => tryRun(crateOrphanCheck), 40);
    system.runInterval(() => tryRun(raceTick), 2);
    system.runInterval(() => tryRun(cloudTick), 1);
    system.runInterval(() => tryRun(portalTick), 4);
    system.runInterval(() => tryRun(realmTick), 5);
});
