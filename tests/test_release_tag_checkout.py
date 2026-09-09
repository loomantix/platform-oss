"""Exercise checkout's peeled-tag refetch and the release recovery script."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / ".github/scripts/restore-release-tag.sh"


class ReleaseTagCheckoutTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.origin = root / "origin.git"
        self.repo = root / "runner"
        self.env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GITHUB_REF_NAME": "review-ledger-v0.0.0-test",
        }
        self.git(root, "init", "--bare", str(self.origin))
        self.git(root, "init", "-b", "main", str(self.repo))
        self.git(self.repo, "config", "user.name", "Release Test")
        self.git(self.repo, "config", "user.email", "release@example.invalid")
        self.git(self.repo, "commit", "--allow-empty", "-m", "fixture")
        self.head = self.git(self.repo, "rev-parse", "HEAD")
        self.env["GITHUB_SHA"] = self.head
        self.git(self.repo, "remote", "add", "origin", str(self.origin))

    def git(self, cwd, *args):
        return subprocess.check_output(
            ["git", *args], cwd=cwd, env=self.env, stderr=subprocess.DEVNULL, text=True
        ).strip()

    def prepare_checkout(self, annotated=True, different_target=False):
        if different_target:
            self.git(self.repo, "commit", "--allow-empty", "-m", "different target")
        tag = self.env["GITHUB_REF_NAME"]
        args = ["tag", "-a", tag, "-m", "fixture"] if annotated else ["tag", tag]
        self.git(self.repo, *args)
        original = self.git(self.repo, "rev-parse", "refs/tags/" + tag)
        self.git(self.repo, "push", "origin", "main", "refs/tags/" + tag)
        # Exact refspec shape observed in actions/checkout's targeted refetch.
        self.git(self.repo, "fetch", "--no-tags", "origin", f"+{self.head}:refs/tags/{tag}")
        self.assertEqual(self.git(self.repo, "cat-file", "-t", "refs/tags/" + tag), "commit")
        return original

    def restore(self):
        return subprocess.run(
            ["bash", str(SCRIPT)], cwd=self.repo, env=self.env, capture_output=True, text=True
        )

    def test_restores_original_annotated_object_without_changing_remote(self):
        original = self.prepare_checkout()
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        ref = "refs/tags/" + self.env["GITHUB_REF_NAME"]
        self.assertEqual(self.git(self.repo, "rev-parse", ref), original)
        self.assertEqual(self.git(self.origin, "rev-parse", ref), original)

    def test_rejects_lightweight_remote_tag(self):
        self.prepare_checkout(annotated=False)
        self.assertNotEqual(self.restore().returncode, 0)

    def test_rejects_tag_targeting_another_commit(self):
        self.prepare_checkout(different_target=True)
        self.assertNotEqual(self.restore().returncode, 0)


if __name__ == "__main__":
    unittest.main()
