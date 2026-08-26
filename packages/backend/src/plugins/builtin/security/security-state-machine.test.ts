import { describe, expect, it, vi } from "vitest";
import {
  type ArmMode,
  alertsForTier,
  isPerimeterTrigger,
  parseEntityList,
  resolveSecurityLists,
  type SecurityEffects,
  type SecurityMachineConfig,
  type SecuritySnapshot,
  SecurityStateMachine,
  watchedTriggerEntities,
} from "./security-state-machine.js";

interface Recorded {
  switches: Record<ArmMode, boolean>[];
  reached: ArmMode[];
  disarmed: number;
  tripped: { tier: string; entityId: string }[];
  cleared: number;
  persisted: SecuritySnapshot[];
}

function recorder(): { effects: SecurityEffects; rec: Recorded } {
  const rec: Recorded = {
    switches: [],
    reached: [],
    disarmed: 0,
    tripped: [],
    cleared: 0,
    persisted: [],
  };
  const effects: SecurityEffects = {
    switchStates: (states) => rec.switches.push({ ...states }),
    modeReached: (mode) => rec.reached.push(mode),
    disarmed: () => {
      rec.disarmed++;
    },
    tripped: (tier, entityId) => rec.tripped.push({ tier, entityId }),
    alarmCleared: () => {
      rec.cleared++;
    },
    persist: (snapshot) => rec.persisted.push({ ...snapshot }),
  };
  return { effects, rec };
}

interface FakeTask {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function fakeScheduler() {
  const pending: FakeTask[] = [];
  return {
    pending,
    scheduler: {
      schedule(ms: number, fn: () => void): () => void {
        const task: FakeTask = { ms, fn, cancelled: false };
        pending.push(task);
        return () => {
          task.cancelled = true;
        };
      },
    },
    // Runs the next non-cancelled task, as if its timer expired.
    fire(): void {
      for (;;) {
        const task = pending.shift();
        if (!task) return;
        if (task.cancelled) continue;
        task.fn();
        return;
      }
    },
    live(): FakeTask[] {
      return pending.filter((t) => !t.cancelled);
    },
  };
}

const baseConfig: SecurityMachineConfig = {
  exitDelaySeconds: 60,
  entryDelaySeconds: 60,
  triggerTimeSeconds: 120,
  triggers: {
    home: ["binary_sensor.front_door"],
    away: ["binary_sensor.front_door", "binary_sensor.motion"],
    night: ["binary_sensor.motion"],
    vacation: ["binary_sensor.front_door", "binary_sensor.motion"],
  },
  triggers24h: ["binary_sensor.smoke"],
};

function machine(overrides: Partial<SecurityMachineConfig> = {}) {
  const { effects, rec } = recorder();
  const sched = fakeScheduler();
  const m = new SecurityStateMachine(
    { ...baseConfig, ...overrides },
    effects,
    sched.scheduler,
  );
  return { m, rec, sched };
}

const allOff = { home: false, away: false, night: false, vacation: false };

describe("SecurityStateMachine", () => {
  it("arms through the exit delay", () => {
    const { m, rec, sched } = machine();
    m.handleModeSwitch("away", true);
    expect(m.snapshot).toEqual({ mode: "away", phase: "arming" });
    expect(rec.switches.at(-1)).toEqual({ ...allOff, away: true });
    expect(rec.reached).toEqual([]);
    expect(sched.live().map((t) => t.ms)).toEqual([60_000]);
    sched.fire();
    expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
    expect(rec.reached).toEqual(["away"]);
  });

  it("arms immediately with exit delay zero", () => {
    const { m, rec, sched } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("home", true);
    expect(m.snapshot).toEqual({ mode: "home", phase: "armed" });
    expect(rec.reached).toEqual(["home"]);
    expect(sched.live()).toEqual([]);
  });

  it("ignores mode triggers during the exit delay", () => {
    const { m, rec } = machine();
    m.handleModeSwitch("away", true);
    m.handleEntityOn("binary_sensor.front_door", true);
    expect(rec.tripped).toEqual([]);
    expect(m.snapshot.phase).toBe("arming");
  });

  it("gives perimeter triggers the entry delay", () => {
    const { m, rec, sched } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("away", true);
    m.handleEntityOn("binary_sensor.front_door", true);
    expect(m.snapshot.phase).toBe("pending");
    expect(rec.tripped).toEqual([]);
    sched.fire();
    expect(m.snapshot.phase).toBe("triggered");
    expect(rec.tripped).toEqual([
      { tier: "away", entityId: "binary_sensor.front_door" },
    ]);
  });

  it("trips instant classes without delay", () => {
    const { m, rec } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("away", true);
    m.handleEntityOn("binary_sensor.motion", false);
    expect(m.snapshot.phase).toBe("triggered");
    expect(rec.tripped).toEqual([
      { tier: "away", entityId: "binary_sensor.motion" },
    ]);
  });

  it("lets an instant trigger cut a running entry delay short", () => {
    const { m, rec } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("away", true);
    m.handleEntityOn("binary_sensor.front_door", true);
    expect(m.snapshot.phase).toBe("pending");
    m.handleEntityOn("binary_sensor.motion", false);
    expect(m.snapshot.phase).toBe("triggered");
    expect(rec.tripped).toEqual([
      { tier: "away", entityId: "binary_sensor.motion" },
    ]);
  });

  it("trips perimeter instantly with entry delay zero", () => {
    const { m } = machine({ exitDelaySeconds: 0, entryDelaySeconds: 0 });
    m.handleModeSwitch("away", true);
    m.handleEntityOn("binary_sensor.front_door", true);
    expect(m.snapshot.phase).toBe("triggered");
  });

  it("auto-returns to armed after the trigger time", () => {
    const { m, rec, sched } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("night", true);
    m.handleEntityOn("binary_sensor.motion", false);
    expect(sched.live().map((t) => t.ms)).toEqual([120_000]);
    sched.fire();
    expect(m.snapshot).toEqual({ mode: "night", phase: "armed" });
    expect(rec.cleared).toBe(1);
    // Setters ran when the mode was reached, the auto-return must not re-run them.
    expect(rec.reached).toEqual(["night"]);
  });

  it("stays triggered until disarm with trigger time zero", () => {
    const { m, rec, sched } = machine({
      exitDelaySeconds: 0,
      triggerTimeSeconds: 0,
    });
    m.handleModeSwitch("night", true);
    m.handleEntityOn("binary_sensor.motion", false);
    expect(sched.live()).toEqual([]);
    expect(m.snapshot.phase).toBe("triggered");
    m.handleModeSwitch("night", false);
    expect(m.snapshot).toEqual({ mode: null, phase: "disarmed" });
    expect(rec.cleared).toBe(1);
    expect(rec.disarmed).toBe(1);
    expect(rec.switches.at(-1)).toEqual(allOff);
  });

  it("keeps the mode switches exclusive", () => {
    const { m, rec } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("home", true);
    expect(rec.switches.at(-1)).toEqual({ ...allOff, home: true });
    m.handleModeSwitch("away", true);
    expect(rec.switches.at(-1)).toEqual({ ...allOff, away: true });
    expect(m.snapshot.mode).toBe("away");
    // Turning off an inactive mode only re-reports, it does not disarm.
    m.handleModeSwitch("home", false);
    expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
    expect(rec.disarmed).toBe(0);
    // Turning off the active mode disarms.
    m.handleModeSwitch("away", false);
    expect(m.snapshot).toEqual({ mode: null, phase: "disarmed" });
    expect(rec.disarmed).toBe(1);
  });

  it("mirrors an observed mode without running local alarm effects", () => {
    const { m, rec, sched } = machine();

    const changed = m.applyObservedState({ mode: "away", phase: "armed" });

    expect(changed).toBe(true);
    expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
    expect(rec.switches.at(-1)).toEqual({ ...allOff, away: true });
    expect(rec.reached).toEqual([]);
    expect(rec.disarmed).toBe(0);
    expect(rec.tripped).toEqual([]);
    expect(rec.cleared).toBe(0);
    expect(sched.live()).toEqual([]);
  });

  it("preserves the observed mode across phase-only updates", () => {
    const { m, rec } = machine();
    m.applyObservedState({ mode: "night", phase: "armed" });

    m.applyObservedState({ phase: "triggered" });

    expect(m.snapshot).toEqual({ mode: "night", phase: "triggered" });
    expect(rec.switches.at(-1)).toEqual({ ...allOff, night: true });
    expect(rec.tripped).toEqual([]);
  });

  it("mirrors an observed disarm without running off setters", () => {
    const { m, rec } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("home", true);
    rec.reached = [];

    m.applyObservedState({ mode: null, phase: "disarmed" });

    expect(m.snapshot).toEqual({ mode: null, phase: "disarmed" });
    expect(rec.switches.at(-1)).toEqual(allOff);
    expect(rec.reached).toEqual([]);
    expect(rec.disarmed).toBe(0);
  });

  it("does not re-run setters when the armed switch is set on again", () => {
    const { m, rec } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("home", true);
    m.handleModeSwitch("home", true);
    expect(rec.reached).toEqual(["home"]);
  });

  it("trips 24h triggers in every state and never applies the entry delay", () => {
    const { m, rec, sched } = machine();
    // Disarmed, perimeter device class: still trips instantly.
    m.handleEntityOn("binary_sensor.smoke", true);
    expect(m.snapshot).toEqual({ mode: null, phase: "triggered" });
    expect(rec.tripped).toEqual([
      { tier: "24h", entityId: "binary_sensor.smoke" },
    ]);
    // Auto-return goes back to disarmed since it tripped from disarmed.
    sched.fire();
    expect(m.snapshot).toEqual({ mode: null, phase: "disarmed" });
    expect(rec.cleared).toBe(1);
  });

  it("trips 24h triggers while armed and returns to armed", () => {
    const { m, rec, sched } = machine({ exitDelaySeconds: 0 });
    m.handleModeSwitch("home", true);
    m.handleEntityOn("binary_sensor.smoke", true);
    expect(rec.tripped).toEqual([
      { tier: "24h", entityId: "binary_sensor.smoke" },
    ]);
    sched.fire();
    expect(m.snapshot).toEqual({ mode: "home", phase: "armed" });
  });

  it("escalates a 24h trigger during a mode trip and restarts the hold", () => {
    const { m, rec, sched } = machine({
      exitDelaySeconds: 0,
      entryDelaySeconds: 0,
    });
    m.handleModeSwitch("away", true);
    m.handleEntityOn("binary_sensor.front_door", true);
    expect(rec.tripped).toEqual([
      { tier: "away", entityId: "binary_sensor.front_door" },
    ]);
    // Smoke during the burglar trip must still fire the 24h alerts.
    m.handleEntityOn("binary_sensor.smoke", true);
    expect(rec.tripped).toEqual([
      { tier: "away", entityId: "binary_sensor.front_door" },
      { tier: "24h", entityId: "binary_sensor.smoke" },
    ]);
    // The old hold is cancelled, exactly one fresh countdown runs.
    expect(sched.live().map((t) => t.ms)).toEqual([120_000]);
    // A second 24h trigger during a 24h trip is already blaring, no re-fire.
    m.handleEntityOn("binary_sensor.smoke", true);
    expect(rec.tripped).toHaveLength(2);
    sched.fire();
    expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
    expect(rec.cleared).toBe(1);
  });

  it("runs the setters when a trip cut the exit delay short and the alarm auto-returns", () => {
    const { m, rec, sched } = machine();
    m.handleModeSwitch("away", true);
    expect(m.snapshot.phase).toBe("arming");
    m.handleEntityOn("binary_sensor.smoke", true);
    expect(m.snapshot.phase).toBe("triggered");
    expect(rec.reached).toEqual([]);
    sched.fire();
    expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
    // Armed without the setters ever having run would leave the house soft.
    expect(rec.reached).toEqual(["away"]);
  });

  it("clears a standing alarm when arming out of triggered", () => {
    const { m, rec } = machine({
      exitDelaySeconds: 0,
      triggerTimeSeconds: 0,
    });
    m.handleEntityOn("binary_sensor.smoke", true);
    expect(m.snapshot.phase).toBe("triggered");
    m.handleModeSwitch("home", true);
    expect(rec.cleared).toBe(1);
    expect(m.snapshot).toEqual({ mode: "home", phase: "armed" });
  });

  it("persists every transition", () => {
    const { m, rec, sched } = machine();
    m.handleModeSwitch("away", true);
    sched.fire();
    m.handleModeSwitch("away", false);
    expect(rec.persisted).toEqual([
      { mode: "away", phase: "arming", modeReached: false },
      { mode: "away", phase: "armed", modeReached: true },
      { mode: null, phase: "disarmed", modeReached: true },
    ]);
  });

  describe("restore", () => {
    it("resolves arming and pending to armed", () => {
      for (const phase of ["arming", "pending", "armed"] as const) {
        const { m } = machine();
        m.restore({ mode: "away", phase });
        expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
      }
    });

    it("resolves triggered to armed when the trigger time is finite", () => {
      const { m } = machine();
      m.restore({ mode: "home", phase: "triggered" });
      expect(m.snapshot).toEqual({ mode: "home", phase: "armed" });
    });

    it("dispatches the setters when restoring an interrupted exit delay", () => {
      const { m, rec } = machine();
      m.restore({ mode: "away", phase: "arming" });
      expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
      // The exit delay never finished, so the setters never ran pre-restart.
      expect(rec.reached).toEqual(["away"]);
      expect(rec.persisted).toEqual([
        { mode: "away", phase: "armed", modeReached: true },
      ]);
    });

    it("persists the resolved snapshot so a second restart repeats nothing", () => {
      const { m, rec } = machine();
      m.restore({ mode: "away", phase: "pending" });
      expect(rec.persisted).toEqual([
        { mode: "away", phase: "armed", modeReached: true },
      ]);
      expect(rec.reached).toEqual([]);
      const second = machine();
      second.m.restore({ mode: "away", phase: "armed" });
      expect(second.rec.persisted).toEqual([]);
      expect(second.rec.reached).toEqual([]);
    });

    it("persists the resolution of a finite-time triggered snapshot", () => {
      const { m, rec } = machine();
      m.restore({ mode: "home", phase: "triggered" });
      expect(rec.persisted).toEqual([
        { mode: "home", phase: "armed", modeReached: true },
      ]);
    });

    it("dispatches the setters when a triggered snapshot never reached its mode", () => {
      const { m, rec } = machine();
      // Tripped during the exit delay, so the setters never ran pre-restart.
      m.restore({ mode: "away", phase: "triggered", modeReached: false });
      expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
      expect(rec.reached).toEqual(["away"]);
      expect(rec.persisted).toEqual([
        { mode: "away", phase: "armed", modeReached: true },
      ]);
    });

    it("does not replay setters for an old triggered snapshot without the field", () => {
      const { m, rec } = machine();
      m.restore({ mode: "away", phase: "triggered" });
      expect(m.snapshot).toEqual({ mode: "away", phase: "armed" });
      expect(rec.reached).toEqual([]);
    });

    it("keeps triggered when the trigger time is infinite", () => {
      const { m } = machine({ triggerTimeSeconds: 0 });
      m.restore({ mode: "home", phase: "triggered" });
      expect(m.snapshot).toEqual({ mode: "home", phase: "triggered" });
    });

    it("keeps disarmed and ignores garbage", () => {
      const { m, rec } = machine();
      m.restore({ mode: null, phase: "disarmed" });
      expect(m.snapshot).toEqual({ mode: null, phase: "disarmed" });
      m.restore(undefined);
      m.restore({ mode: "nope", phase: "armed" } as never);
      expect(m.snapshot).toEqual({ mode: null, phase: "disarmed" });
      // Restore replays no side effects, setters and alerts already ran.
      expect(rec.reached).toEqual([]);
      expect(rec.disarmed).toBe(0);
    });
  });
});

describe("resolveSecurityLists", () => {
  it("falls back to the away lists when vacation is empty", () => {
    const lists = resolveSecurityLists({
      awayTriggers: "binary_sensor.a, binary_sensor.b",
      awayAlerts: "siren.a",
      vacationTriggers: "",
    });
    expect(lists.triggers.vacation).toEqual([
      "binary_sensor.a",
      "binary_sensor.b",
    ]);
    expect(lists.alerts.vacation).toEqual(["siren.a"]);
  });

  it("falls back to the away setters when vacation setters are empty", () => {
    const lists = resolveSecurityLists({
      awaySetters: "scene.away,script.notify",
      vacationSetters: "",
    });
    expect(lists.setters.vacation).toEqual(["scene.away", "script.notify"]);
    expect(lists.setters.away).toEqual(["scene.away", "script.notify"]);
  });

  it("keeps explicit vacation setters", () => {
    const lists = resolveSecurityLists({
      awaySetters: "scene.away",
      vacationSetters: "scene.vacation",
    });
    expect(lists.setters.vacation).toEqual(["scene.vacation"]);
  });

  it("drops alert entities outside the supported domains with one warning", () => {
    const warn = vi.fn();
    const lists = resolveSecurityLists(
      {
        homeAlerts: "siren.a,media_player.tv,light.l",
        alerts24h: "media_player.tv,script.s,scene.x,switch.plug",
      },
      warn,
    );
    expect(lists.alerts.home).toEqual(["siren.a", "light.l"]);
    expect(lists.alerts24h).toEqual(["script.s", "scene.x", "switch.plug"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("media_player.tv");
  });

  it("keeps explicit vacation lists", () => {
    const lists = resolveSecurityLists({
      awayTriggers: "binary_sensor.a",
      vacationTriggers: "binary_sensor.c",
      awayAlerts: "siren.a",
      vacationAlerts: "siren.c",
    });
    expect(lists.triggers.vacation).toEqual(["binary_sensor.c"]);
    expect(lists.alerts.vacation).toEqual(["siren.c"]);
  });
});

describe("alertsForTier", () => {
  it("unions the tier list with the always list, deduped", () => {
    const lists = resolveSecurityLists({
      alerts24h: "siren.a,script.b",
      alwaysAlerts: "light.c,siren.a",
      homeAlerts: "siren.h",
    });
    expect(alertsForTier(lists, "24h")).toEqual([
      "siren.a",
      "script.b",
      "light.c",
    ]);
    expect(alertsForTier(lists, "home")).toEqual([
      "siren.h",
      "light.c",
      "siren.a",
    ]);
  });
});

describe("helpers", () => {
  it("parseEntityList splits, trims and drops empties", () => {
    expect(parseEntityList(" a.b, c.d ,,")).toEqual(["a.b", "c.d"]);
    expect(parseEntityList(undefined)).toEqual([]);
    expect(parseEntityList(42)).toEqual([]);
  });

  it("parseEntityList dedupes, first occurrence wins", () => {
    expect(parseEntityList("a.b,c.d,a.b")).toEqual(["a.b", "c.d"]);
  });

  it("isPerimeterTrigger needs a binary_sensor with a perimeter class", () => {
    expect(isPerimeterTrigger("binary_sensor.door", "door")).toBe(true);
    expect(isPerimeterTrigger("binary_sensor.window", "window")).toBe(true);
    expect(isPerimeterTrigger("binary_sensor.gd", "garage_door")).toBe(true);
    expect(isPerimeterTrigger("binary_sensor.gate", "opening")).toBe(true);
    expect(isPerimeterTrigger("binary_sensor.pir", "motion")).toBe(false);
    expect(isPerimeterTrigger("binary_sensor.x", undefined)).toBe(false);
    expect(isPerimeterTrigger("switch.door", "door")).toBe(false);
  });

  it("watchedTriggerEntities unions every trigger list", () => {
    const lists = resolveSecurityLists({
      homeTriggers: "binary_sensor.a",
      awayTriggers: "binary_sensor.b",
      triggers24h: "binary_sensor.smoke",
    });
    expect([...watchedTriggerEntities(lists)].sort()).toEqual([
      "binary_sensor.a",
      "binary_sensor.b",
      "binary_sensor.smoke",
    ]);
  });
});
