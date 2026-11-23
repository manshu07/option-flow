# Project Change Guardrails

These rules apply to every feature, fix, and refactor in Order Flow.

## Preserve Existing Behavior

- Prefer additive, backward-compatible changes. Keep the current board, controls, APIs, providers, and workflows working unless the user explicitly approves a change to them.
- Do not remove, rename, replace, or silently change existing functionality to make room for a new feature.
- Before proposing any breaking or behavior-changing change, identify its callers, consumers, data/persistence effects, and migration impact; explain alternatives and wait for explicit user approval.

## Reuse Before Reinventing

- Inspect the existing implementation before designing a new abstraction, component, endpoint, provider, dependency, or workflow.
- Reuse current models, hooks, components, schemas, provider contracts, persistence paths, styling patterns, and test utilities where they fit.
- Add a new dependency or parallel implementation only when the existing code cannot safely support the requirement; explain why before proceeding.

## Impact Analysis And Approval

- Before implementing a non-trivial change, trace the relevant data flow and dependencies across frontend, server, providers, persistence, session/time handling, and tests.
- Explain the proposed scope and all identified side effects, affected functionality, compatibility risks, operational/rate-limit implications, alternatives, and verification plan to the user before editing.
- Wait for the user's explicit approval of that plan before starting implementation. Do not infer approval from silence or from a separate task's approval.
- Re-check the impact analysis when new findings or requirements change the plan.

## Verification

- Add tests for the behavior and compatibility boundaries changed; prefer deterministic fixtures and fixed clocks/dates.
- Verify the existing live path as well as the new path. Preserve provider contracts and do not call live providers from tests unless explicitly authorized.
- Report any unavailable test, environment dependency, or unverified runtime behavior rather than presenting it as passing.
