"use strict";
// Tests for command decomposition and multiplexer canonicalization.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { decomposeCommand, canonicalize, parseFlags, basename } = require("../../src/shellplan/decompose");

describe("shellplan/decompose: simple extraction", () => {
  it("extracts program, argv, flags, operands", () => {
    const { commands } = decomposeCommand("ls -la --color=auto /tmp");
    assert.equal(commands.length, 1);
    const c = commands[0];
    assert.equal(c.program, "ls");
    assert.deepEqual(c.argv, ["ls", "-la", "--color=auto", "/tmp"]);
    assert.ok(c.flags.some(f => f.name === "-la"));
    assert.ok(c.flags.some(f => f.name === "--color" && f.value === "auto"));
    assert.deepEqual(c.operands, ["/tmp"]);
  });

  it("extracts multiple commands across a pipeline and sequence", () => {
    const { commands } = decomposeCommand("cat f | grep x > out; echo done");
    const simple = commands.filter(c => c.kind === "simple");
    assert.deepEqual(simple.map(c => c.program), ["cat", "grep", "echo"]);
  });

  it("marks pipeline position and connectors", () => {
    const { commands } = decomposeCommand("a | b");
    assert.equal(commands[0].pipedInto, true);
    assert.equal(commands[1].receivesPipe, true);
  });

  it("records && / || connector on the receiving command", () => {
    const { commands } = decomposeCommand("make && test");
    assert.equal(commands[1].connector, "&&");
  });

  it("captures env assignments separate from argv", () => {
    const { commands } = decomposeCommand("NODE_ENV=production node app.js");
    assert.deepEqual(commands[0].assignments, [{ name: "NODE_ENV", value: "production" }]);
    assert.equal(commands[0].program, "node");
  });

  it("resolves program basename for an absolute path", () => {
    const { commands } = decomposeCommand("/usr/bin/git status");
    assert.equal(commands[0].programBase, "git");
    assert.equal(commands[0].canonical.subcommand, "status");
  });

  it("marks background execution", () => {
    const { commands } = decomposeCommand("sleep 10 &");
    assert.equal(commands[0].background, true);
  });

  it("records subshell structure", () => {
    const { commands } = decomposeCommand("(cd /tmp && rm x)");
    assert.equal(commands[0].kind, "subshell");
    assert.ok(commands.slice(1).some(c => c.inSubshell));
  });
});

describe("shellplan/decompose: flag parser", () => {
  it("separates long, short, grouped, and -- terminator", () => {
    const { flags, operands } = parseFlags(["-v", "--out=x", "-abc", "--", "-notaflag"]);
    assert.ok(flags.find(f => f.name === "-v"));
    assert.ok(flags.find(f => f.name === "--out" && f.value === "x"));
    const grouped = flags.find(f => f.name === "-abc");
    assert.deepEqual(grouped.letters, ["a", "b", "c"]);
    assert.deepEqual(operands, ["-notaflag"]);
  });

  it("treats a lone - as an operand", () => {
    const { operands } = parseFlags(["-"]);
    assert.deepEqual(operands, ["-"]);
  });
});

describe("shellplan/decompose: multiplexer canonicalization", () => {
  it("canonicalizes git subcommand", () => {
    const c = canonicalize("git", ["git", "commit", "-m", "msg"], {});
    assert.equal(c.tool, "git");
    assert.equal(c.subcommand, "commit");
    assert.deepEqual(c.subArgs, ["-m", "msg"]);
  });

  it("resolves git aliases (co -> checkout)", () => {
    const c = canonicalize("git", ["git", "co", "main"], {});
    assert.equal(c.subcommand, "checkout");
  });

  it("skips git global flags that take a value (-C <dir>)", () => {
    const c = canonicalize("git", ["git", "-C", "/repo", "status"], {});
    assert.equal(c.subcommand, "status");
  });

  it("handles git --git-dir=... inline value", () => {
    const c = canonicalize("git", ["git", "--git-dir=/x/.git", "log"], {});
    assert.equal(c.subcommand, "log");
  });

  it("canonicalizes npm aliases (i -> install)", () => {
    const c = canonicalize("npm", ["npm", "i", "left-pad"], {});
    assert.equal(c.subcommand, "install");
  });

  it("builds a two-level chain for docker image rm", () => {
    const c = canonicalize("docker", ["docker", "image", "rm", "abc"], {});
    assert.deepEqual(c.chain, ["docker", "image", "rm"]);
  });

  it("returns null subcommand for a non-multiplexer", () => {
    const c = canonicalize("ls", ["ls", "-la"], {});
    assert.equal(c.subcommand, null);
    assert.equal(c.tool, "ls");
  });
});

describe("shellplan/decompose: runner unwrapping", () => {
  it("unwraps sudo to the inner command", () => {
    const { commands } = decomposeCommand("sudo rm -rf /var/log");
    const c = commands[0];
    assert.equal(c.programBase, "sudo");
    assert.equal(c.effectiveBase, "rm");
    assert.deepEqual(c.wrappers, ["sudo"]);
    assert.ok(c.operands.includes("/var/log"));
  });

  it("skips sudo value flags (-u user)", () => {
    const { commands } = decomposeCommand("sudo -u deploy systemctl restart x");
    assert.equal(commands[0].effectiveBase, "systemctl");
  });

  it("unwraps env with assignments", () => {
    const { commands } = decomposeCommand("env FOO=bar node app.js");
    assert.equal(commands[0].effectiveBase, "node");
  });

  it("unwraps timeout and its duration", () => {
    const { commands } = decomposeCommand("timeout 30 git fetch");
    assert.equal(commands[0].effectiveBase, "git");
    assert.equal(commands[0].canonical.subcommand, "fetch");
  });

  it("unwraps nested runners (sudo nohup)", () => {
    const { commands } = decomposeCommand("sudo nohup ./server");
    assert.deepEqual(commands[0].wrappers, ["sudo", "nohup"]);
    assert.equal(commands[0].effectiveBase, "server");
  });

  it("keeps a bare runner with no inner command", () => {
    const { commands } = decomposeCommand("sudo");
    assert.equal(commands[0].effectiveBase, "sudo");
  });

  it("canonicalizes the inner multiplexer under sudo", () => {
    const { commands } = decomposeCommand("sudo git push --force");
    assert.equal(commands[0].canonical.tool, "git");
    assert.equal(commands[0].canonical.subcommand, "push");
  });
});

describe("shellplan/decompose: helpers", () => {
  it("basename strips directories", () => {
    assert.equal(basename("/usr/local/bin/node"), "node");
    assert.equal(basename("node"), "node");
    assert.equal(basename(""), "");
  });

  it("flags hasExpansion and hasGlob", () => {
    const { commands } = decomposeCommand("echo $HOME *.js");
    assert.equal(commands[0].hasExpansion, true);
    assert.equal(commands[0].hasGlob, true);
  });
});
