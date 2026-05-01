#!/usr/bin/env python3
"""Create GitHub phase issues from a phase plan JSON file.

Usage:
  python scripts/create_phase_issues.py .agent/templates/phase-plan.example.json owner/repo

Requirements:
  - Python 3.10+
  - GitHub CLI authenticated: gh auth login
  - `gh` available on PATH

The script intentionally shells out to `gh issue create` so it works without storing tokens in code.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def body_for_phase(parent_issue: str, phase: dict) -> str:
    tasks_md = []
    for task in phase.get("tasks", []):
        tasks_md.append(f"- [ ] {task['title']}")
        for subtask in task.get("subtasks", []):
            tasks_md.append(f"  - [ ] {subtask}")

    acceptance_md = "\n".join(f"- [ ] {item}" for item in phase.get("acceptance_criteria", []))
    qa_md = "\n".join(f"- [ ] {item}" for item in phase.get("qa_plan", []))
    risks_md = "\n".join(f"- {item}" for item in phase.get("risks", [])) or "- None documented yet"

    return f"""Parent: {parent_issue}

## Goal

{phase['goal']}

## Tasks and subtasks

{chr(10).join(tasks_md)}

## Acceptance criteria

{acceptance_md}

## QA / validation plan

{qa_md}

## Risks

{risks_md}

## Learnings log

- Attempt:
  Result:
  Learning:

## Trial and error log

- Attempt:
  Result:
  Next action:

## Outcome

Completed:
Deferred:
Follow-up issues:
Rollback notes:

## Status gate

{phase['status_gate']}
"""


def main() -> int:
    require(len(sys.argv) == 3, "Usage: create_phase_issues.py <phase-plan.json> <owner/repo>")
    require(shutil.which("gh") is not None, "GitHub CLI `gh` is required and must be on PATH.")

    plan_path = Path(sys.argv[1])
    repo = sys.argv[2]

    if not plan_path.exists():
        raise SystemExit(f"Error: Plan file not found: {plan_path}")
    if not plan_path.is_file():
        raise SystemExit(f"Error: Path is not a file: {plan_path}")

    try:
        plan = json.loads(plan_path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Error: Invalid JSON in {plan_path}: {exc}") from exc

    parent_issue = plan["parent_issue"]
    for phase in plan["phases"]:
        prefix = phase["type"].capitalize()
        title = f"[{prefix}][Phase {phase['number']}]: {phase['title']}"
        labels = ",".join(phase.get("labels", []))
        body = body_for_phase(parent_issue, phase)

        # Write body to a temp file to avoid OS command-line length limits
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as tmp:
            tmp.write(body)
            tmp_path = Path(tmp.name)

        try:
            cmd = ["gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", str(tmp_path)]
            if labels:
                cmd.extend(["--label", labels])
            print(f"Creating: {title}")
            subprocess.run(cmd, check=True)
        finally:
            tmp_path.unlink(missing_ok=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
