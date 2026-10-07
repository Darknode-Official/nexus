"use strict";
// Tests for static file-target extraction (reads/writes/deletes + confidence).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractFileTargets, looksLikePath, isDynamic } = require("../../src/shellplan/filetargets");

function find(targets, path, access) { return targets.find(t => t.path === path && (!access || t.access === access)); }

describe("shellplan/filetargets: redirections", () => {
  it("> is a write (truncate)", () => {
    const r = extractFileTargets("echo hi > out.txt");
    assert.ok(find(r.writes, "out.txt"));
  });
  it(">> is a write (append)", () => {
    const r = extractFileTargets("echo hi >> log.txt");
    const t = find(r.writes, "log.txt");
    assert.ok(t);
    assert.equal(t.append, true);
  });
  it("< is a read", () => {
    const r = extractFileTargets("sort < data.txt");
    assert.ok(find(r.reads, "data.txt"));
  });
  it("2> is a write", () => {
    const r = extractFileTargets("cmd 2> errors.log");
    assert.ok(find(r.writes, "errors.log"));
  });
  it("heredoc body is not a file target", () => {
    const r = extractFileTargets("cat <<EOF\nhello\nEOF");
    assert.equal(r.all.length, 0);
  });
});

describe("shellplan/filetargets: tool semantics", () => {
  it("rm deletes operands", () => {
    const r = extractFileTargets("rm a.txt b.txt");
    assert.ok(find(r.deletes, "a.txt"));
    assert.ok(find(r.deletes, "b.txt"));
  });

  it("cp reads sources and writes destination", () => {
    const r = extractFileTargets("cp src1 src2 destdir");
    assert.ok(find(r.reads, "src1"));
    assert.ok(find(r.reads, "src2"));
    assert.ok(find(r.writes, "destdir"));
  });

  it("mv deletes source and writes destination", () => {
    const r = extractFileTargets("mv old.txt new.txt");
    assert.ok(find(r.deletes, "old.txt"));
    assert.ok(find(r.writes, "new.txt"));
  });

  it("tee writes its file operands", () => {
    const r = extractFileTargets("echo x | tee out.txt");
    assert.ok(find(r.writes, "out.txt"));
  });

  it("tee -a appends", () => {
    const r = extractFileTargets("echo x | tee -a out.txt");
    assert.equal(find(r.writes, "out.txt").append, true);
  });

  it("sed -i edits in place (write)", () => {
    const r = extractFileTargets("sed -i 's/a/b/' file.txt");
    assert.ok(find(r.writes, "file.txt"));
  });

  it("sed without -i only reads", () => {
    const r = extractFileTargets("sed 's/a/b/' file.txt");
    assert.ok(find(r.reads, "file.txt"));
    assert.equal(r.writes.length, 0);
  });

  it("dd reads if= and writes of=", () => {
    const r = extractFileTargets("dd if=/dev/zero of=disk.img bs=1M");
    assert.ok(find(r.reads, "/dev/zero"));
    assert.ok(find(r.writes, "disk.img"));
  });

  it("cat reads operands", () => {
    const r = extractFileTargets("cat README.md");
    assert.ok(find(r.reads, "README.md"));
  });

  it("truncate writes its target", () => {
    const r = extractFileTargets("truncate -s 0 big.log");
    assert.ok(find(r.writes, "big.log"));
  });

  it("tar -c writes the archive", () => {
    const r = extractFileTargets("tar -czf backup.tgz src/");
    assert.ok(find(r.writes, "backup.tgz"));
  });

  it("grep reads file operands but not the pattern", () => {
    const r = extractFileTargets("grep pattern file.txt");
    assert.ok(find(r.reads, "file.txt"));
    assert.equal(find(r.reads, "pattern"), undefined);
  });
});

describe("shellplan/filetargets: confidence and dynamic", () => {
  it("assigns high confidence to redirection writes", () => {
    const r = extractFileTargets("echo x > out");
    assert.ok(find(r.writes, "out").confidence >= 0.9);
  });

  it("flags dynamic targets ($VAR, globs)", () => {
    const r = extractFileTargets("rm -rf $BUILD_DIR");
    const t = r.deletes.find(x => x.path === "$BUILD_DIR");
    assert.ok(t);
    assert.equal(t.dynamic, true);
  });

  it("uses a low-confidence heuristic for unknown tools with path-like operands", () => {
    const r = extractFileTargets("myunknowntool ./config.json");
    const t = find(r.reads, "./config.json");
    assert.ok(t);
    assert.ok(t.confidence < 0.5);
    assert.equal(t.source, "heuristic");
  });

  it("does not treat flags or URLs as paths in the heuristic", () => {
    const r = extractFileTargets("myunknowntool --flag http://example.com/x");
    assert.equal(r.all.length, 0);
  });
});

describe("shellplan/filetargets: combined and multi-command", () => {
  it("aggregates across a sequence", () => {
    const r = extractFileTargets("cp a b && rm c > log 2>&1");
    assert.ok(find(r.reads, "a"));
    assert.ok(find(r.writes, "b"));
    assert.ok(find(r.deletes, "c"));
    assert.ok(find(r.writes, "log"));
  });

  it("tags each target with its command index and program", () => {
    const r = extractFileTargets("rm x");
    assert.equal(r.all[0].program, "rm");
    assert.equal(typeof r.all[0].commandIndex, "number");
  });
});

describe("shellplan/filetargets: unit helpers", () => {
  it("looksLikePath recognizes paths and rejects flags/urls", () => {
    assert.equal(looksLikePath("./a.txt"), true);
    assert.equal(looksLikePath("dir/file"), true);
    assert.equal(looksLikePath("-v"), false);
    assert.equal(looksLikePath("https://x.com/a"), false);
    assert.equal(looksLikePath("user@host:/path"), false);
    assert.equal(looksLikePath("plainword"), false);
  });

  it("isDynamic detects expansions and globs", () => {
    assert.equal(isDynamic("$HOME/x"), true);
    assert.equal(isDynamic("*.log"), true);
    assert.equal(isDynamic("static/path.txt"), false);
  });
});
