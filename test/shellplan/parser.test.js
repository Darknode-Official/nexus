"use strict";
// Tests for the shellplan POSIX-ish parser: tokenization, quoting, pipelines,
// and-or sequences, subshells, redirections, command substitution, parameter
// expansion, globs, and heredocs. Tricky quoting is the focus.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parse, tokenize, isAssignment } = require("../../src/shellplan/parser");

// -- helpers to reach into the AST without repeating long paths --
function firstPipeline(ast) { return ast.list.parts[0].andOr.pipelines[0].pipeline; }
function firstCommand(ast) { return firstPipeline(ast).commands[0]; }
function words(cmd) { return cmd.words.map(w => w.text); }

describe("shellplan/parser: tokenize basics", () => {
  it("splits plain words on whitespace", () => {
    const { tokens, errors } = tokenize("echo hello world");
    assert.equal(errors.length, 0);
    const w = tokens.filter(t => t.type === "word").map(t => t.text);
    assert.deepEqual(w, ["echo", "hello", "world"]);
  });

  it("recognizes operators longest-first", () => {
    const { tokens } = tokenize("a >> b");
    const ops = tokens.filter(t => t.type === "op").map(t => t.value);
    assert.deepEqual(ops, [">>"]);
  });

  it("treats a leading # as a comment", () => {
    const { tokens } = tokenize("# just a comment");
    assert.equal(tokens.filter(t => t.type === "word").length, 0);
  });

  it("does not treat a # mid-word as a comment", () => {
    const { tokens } = tokenize("echo a#b");
    const w = tokens.filter(t => t.type === "word").map(t => t.text);
    assert.deepEqual(w, ["echo", "a#b"]);
  });
});

describe("shellplan/parser: quoting", () => {
  it("keeps single-quoted content literal (no expansion)", () => {
    const ast = parse("echo '$HOME and `date`'");
    const w = firstCommand(ast).words[1];
    assert.equal(w.text, "$HOME and `date`");
    assert.equal(w.quoted, true);
    assert.equal(w.expansions.length, 0);
  });

  it("expands inside double quotes", () => {
    const ast = parse('echo "$HOME is home"');
    const w = firstCommand(ast).words[1];
    assert.equal(w.quoted, true);
    assert.equal(w.expansions[0].type, "param");
    assert.equal(w.expansions[0].name, "HOME");
  });

  it("handles backslash escaping outside quotes", () => {
    const ast = parse("echo a\\ b");
    // "a\ b" is a single word with a literal space
    assert.deepEqual(words(firstCommand(ast)), ["echo", "a b"]);
  });

  it("handles escaped quotes inside double quotes", () => {
    const ast = parse('echo "she said \\"hi\\""');
    assert.equal(firstCommand(ast).words[1].text, 'she said "hi"');
  });

  it("concatenates adjacent quoted and unquoted segments into one word", () => {
    const ast = parse("echo foo'bar'\"baz\"");
    assert.deepEqual(words(firstCommand(ast)), ["echo", "foobarbaz"]);
  });

  it("reports an unterminated single quote", () => {
    const { errors } = tokenize("echo 'oops");
    assert.ok(errors.some(e => /unterminated single quote/.test(e)));
  });

  it("reports an unterminated double quote", () => {
    const { errors } = tokenize('echo "oops');
    assert.ok(errors.some(e => /unterminated double quote/.test(e)));
  });
});

describe("shellplan/parser: pipelines and and-or", () => {
  it("parses a pipeline", () => {
    const ast = parse("ls -la | grep foo | wc -l");
    const p = firstPipeline(ast);
    assert.equal(p.commands.length, 3);
    assert.deepEqual(p.commands.map(c => c.words[0].text), ["ls", "grep", "wc"]);
  });

  it("parses && and || with connectors", () => {
    const ast = parse("make && test || echo fail");
    const ao = ast.list.parts[0].andOr;
    assert.equal(ao.pipelines.length, 3);
    assert.equal(ao.pipelines[0].connector, null);
    assert.equal(ao.pipelines[1].connector, "&&");
    assert.equal(ao.pipelines[2].connector, "||");
  });

  it("parses ; sequences into separate parts", () => {
    const ast = parse("a; b; c");
    assert.equal(ast.list.parts.length, 3);
    assert.equal(ast.list.parts[0].separator, ";");
  });

  it("records background & as a separator", () => {
    const ast = parse("server & client");
    assert.equal(ast.list.parts[0].separator, "&");
  });

  it("parses a negated pipeline", () => {
    const ast = parse("! grep foo file");
    assert.equal(firstPipeline(ast).negated, true);
  });
});

describe("shellplan/parser: redirections", () => {
  it("parses > and >> and <", () => {
    const ast = parse("cmd < in.txt > out.txt 2>> err.log");
    const redirs = firstCommand(ast).redirs;
    const byOp = Object.fromEntries(redirs.map(r => [r.op, r.target && r.target.text]));
    assert.equal(byOp["<"], "in.txt");
    assert.equal(byOp[">"], "out.txt");
    assert.equal(byOp["2>>"], "err.log");
  });

  it("parses fd-prefixed redirections", () => {
    const ast = parse("cmd 2> errors");
    const r = firstCommand(ast).redirs[0];
    assert.equal(r.op, "2>");
    assert.equal(r.fd, 2);
    assert.equal(r.target.text, "errors");
  });

  it("parses 2>&1 as an fd duplication", () => {
    const ast = parse("cmd > out 2>&1");
    const dup = firstCommand(ast).redirs.find(r => r.op === "2>&1");
    assert.ok(dup);
    assert.equal(dup.dupTo, 1);
  });

  it("flags a redirection with a missing target", () => {
    const ast = parse("cmd >");
    assert.ok(ast.errors.some(e => /missing target/.test(e)));
  });
});

describe("shellplan/parser: command substitution and expansion", () => {
  it("parses $(...) command substitution and captures inner command", () => {
    const ast = parse("echo $(git rev-parse HEAD)");
    const w = firstCommand(ast).words[1];
    assert.equal(w.expansions[0].type, "command_sub");
    assert.equal(w.expansions[0].command, "git rev-parse HEAD");
  });

  it("parses backtick command substitution", () => {
    const ast = parse("echo `whoami`");
    const w = firstCommand(ast).words[1];
    assert.equal(w.expansions[0].type, "command_sub");
    assert.equal(w.expansions[0].command, "whoami");
  });

  it("parses nested $() substitution", () => {
    const ast = parse("echo $(echo $(date))");
    const w = firstCommand(ast).words[1];
    assert.equal(w.expansions[0].type, "command_sub");
    assert.equal(w.expansions[0].command, "echo $(date)");
  });

  it("parses ${VAR} parameter expansion", () => {
    const ast = parse("echo ${PATH}");
    assert.equal(firstCommand(ast).words[1].expansions[0].name, "PATH");
  });

  it("parses arithmetic $((...)) without treating it as a command", () => {
    const ast = parse("echo $((1 + 2))");
    assert.equal(firstCommand(ast).words[1].expansions[0].type, "arithmetic");
  });

  it("does not expand inside single quotes even with $()", () => {
    const ast = parse("echo '$(rm -rf /)'");
    assert.equal(firstCommand(ast).words[1].expansions.length, 0);
    assert.equal(firstCommand(ast).words[1].text, "$(rm -rf /)");
  });
});

describe("shellplan/parser: globs", () => {
  it("marks unquoted globs", () => {
    const ast = parse("rm *.log");
    assert.equal(firstCommand(ast).words[1].glob, true);
  });

  it("does not mark quoted globs", () => {
    const ast = parse("rm '*.log'");
    assert.equal(firstCommand(ast).words[1].glob, false);
  });
});

describe("shellplan/parser: subshells and groups", () => {
  it("parses a subshell", () => {
    const ast = parse("(cd /tmp && ls)");
    const cmd = firstCommand(ast);
    assert.equal(cmd.type, "subshell");
    assert.equal(cmd.list.parts[0].andOr.pipelines.length, 2);
  });

  it("parses subshell with trailing redirection", () => {
    const ast = parse("(echo hi) > out.txt");
    const cmd = firstCommand(ast);
    assert.equal(cmd.type, "subshell");
    assert.equal(cmd.redirs[0].target.text, "out.txt");
  });

  it("flags a missing closing paren", () => {
    const ast = parse("(echo hi");
    assert.ok(ast.errors.some(e => /missing \)/.test(e)));
  });
});

describe("shellplan/parser: heredocs", () => {
  it("captures heredoc body", () => {
    const ast = parse("cat <<EOF\nline one\nline two\nEOF");
    const r = firstCommand(ast).redirs[0];
    assert.equal(r.op, "<<");
    assert.equal(r.heredoc.body, "line one\nline two");
    assert.equal(r.heredoc.delim, "EOF");
  });

  it("supports <<- tab stripping", () => {
    const ast = parse("cat <<-END\n\tindented\nEND");
    const r = firstCommand(ast).redirs[0];
    assert.equal(r.heredoc.body, "indented");
  });

  it("reports an unterminated heredoc", () => {
    const { errors } = tokenize("cat <<EOF\nno terminator\n");
    assert.ok(errors.some(e => /unterminated heredoc/.test(e)));
  });
});

describe("shellplan/parser: assignments", () => {
  it("collects leading env assignments", () => {
    const ast = parse("FOO=bar BAZ=qux cmd arg");
    const cmd = firstCommand(ast);
    assert.deepEqual(cmd.assignments.map(a => [a.name, a.value]), [["FOO", "bar"], ["BAZ", "qux"]]);
    assert.deepEqual(words(cmd), ["cmd", "arg"]);
  });

  it("does not treat a mid-command FOO=bar as an assignment", () => {
    const ast = parse("cmd FOO=bar");
    assert.equal(firstCommand(ast).assignments.length, 0);
    assert.deepEqual(words(firstCommand(ast)), ["cmd", "FOO=bar"]);
  });

  it("isAssignment helper matches valid names only", () => {
    assert.equal(isAssignment("A=1"), true);
    assert.equal(isAssignment("_x=1"), true);
    assert.equal(isAssignment("1A=1"), false);
    assert.equal(isAssignment("a.b=1"), false);
  });
});

describe("shellplan/parser: robustness", () => {
  it("handles empty input", () => {
    const ast = parse("");
    assert.equal(ast.list.parts.length, 0);
    assert.equal(ast.errors.length, 0);
  });

  it("handles whitespace-only input", () => {
    const ast = parse("   \t  ");
    assert.equal(ast.list.parts.length, 0);
  });

  it("handles null/undefined input without throwing", () => {
    assert.doesNotThrow(() => parse(undefined));
    assert.doesNotThrow(() => parse(null));
  });

  it("parses a complex real-world line end to end", () => {
    const ast = parse('FOO=1 git -C /repo commit -m "fix: $(date)" && echo done | tee log.txt');
    assert.equal(ast.errors.length, 0);
    const ao = ast.list.parts[0].andOr;
    assert.equal(ao.pipelines.length, 2);
    assert.equal(ao.pipelines[0].pipeline.commands[0].assignments[0].name, "FOO");
  });
});
