# Source and verification provenance

The files under `contrib/community/docker-remote-mcp/` are an exact export
of the tracked companion at source commit
`f8d6c729ed767da0003fc1ce35c4c2936b466a21` in an unpublished contribution
branch based on e2e-inc/e2e. These source identifiers are recorded here for
auditing; they are not claimed as publicly available upstream commits.
`SOURCE-SHA256SUMS` records every exported file using its original path.
The root README, this document, the checksum manifest and the root LICENSE
are publication additions. The root LICENSE is an exact copy of the
companion LICENSE. No executable code changed during export.

The preceding runtime commit was
`0fad116f5adcaaed2d10b9c76aca97f41050cced`. Author evidence at that revision
covered real Chromium, two MCP clients, reconnect, ownership refusal,
`run_tests` reports and PNGs, and cancellation/disconnect/expiry/shutdown
cleanup on the host and in Docker/Compose. Those runtime checks were not
rerun on the final fixture-only source commit.

At the final source revision, the author ran four focused fixture tests on
the host, in a newly built image and under Compose, with eleven source/image
hashes matching. The tests covered reparenting, inspection denial after
spawn, cleanup/receipt error aggregation and bounded self-expiry. A protected
red reconstruction failed as expected without leaving a persistent fixture.
An independent reviewer reran three safe cases without global process
inspection and reported no new findings. The independent review did not
rerun Docker, Compose, global process checks or full browser/MCP proofs.

Evidence documents retained separately for audit:

- Final author report SHA256:
  `9deaa61d046e29972531eb43b79d0b7a3f6633bbf757752beb0ea54607d5204c`.
- Final author evidence archive SHA256:
  `6e7c7b11270578066356a379ba2e48365fcfb2bb99d653eec0abd6acb70c667e`.
- Independent review SHA256:
  `06d95c87ff426b0b416bdb121ed23b6a81ba3436aa9e1ba5061ad72224d4a6da`.

Raw local receipts and artifacts are not part of this public export.
The companion's [VERIFICATION.md](contrib/community/docker-remote-mcp/VERIFICATION.md)
records the validation scope and limitations. Publication verifies source
identity and public availability, without claiming a new runtime test run,
upstream API agreement, deployment or official support.
