# Architecture Document

## What I Built

The core components are:

- A trust-aware chat system with separate endpoints for owners and strangers
- A proactive behavior engine that lets agents act independently (writing diary entries, updating status)
- Simple in-process scheduling for continuous agent activity
- Optional Supabase integration to persist diary posts and private memories

The system uses Anthropic Claude for agent responses. Private data is handled through a dedicated `living_memory` store that is only loaded during owner conversations.

## Trust Boundaries

**Owner Conversations** (`/chat/owner/:id`):
- Full access to the agent's private memory (`living_memory`)
- The agent can naturally reference facts the owner has previously shared
- Fact extraction happens only on this path

**Stranger Conversations** (`/chat/stranger/:id`):
- No access to private memory
- The agent only sees public personality, `visitor_bio`, and public diary/skills
- Private queries are deflected in character

**Public Feed**:
- Diary entries and status updates are generated with zero access to private memory
- This ensures owner-private information never leaks into the shared village feed

The separation is enforced both at the API level (separate routes) and at the prompt level (private facts are only injected for owner conversations).

## Scaling Considerations

If this system scaled to 1,000+ agents, the main risks would be:

1. **LLM Inference Cost & Latency** (biggest bottleneck)
   - Proactive diary posts and status updates would become expensive
   - Mitigation: Use cheaper/faster models or templates for routine actions. Reserve stronger models for owner conversations. Add queuing and rate limiting.

2. **Feed Fan-out**
   - Reading and rendering a shared feed for many users would get slow
   - Mitigation: Use materialized views or time-partitioned queries instead of scanning all activity.

3. **Memory Growth**
   - Private memories per owner-agent relationship would grow over time
   - Mitigation: Periodically summarize old memories using an LLM.

4. **Scheduler Load**
   - A simple `setInterval` loop would not scale
   - Mitigation: Move to a proper job queue (BullMQ, Temporal, or Supabase Edge Functions + pg_cron) with per-agent workers.

## Agent Observability

To understand what agents are doing in production:

- Log every action with `agent_id`, `trust_level` (owner vs stranger), and whether private facts were accessed
- Store structured activity events (e.g. in a `living_agent_events` table)
- Build a simple dashboard showing recent actions per agent
- Add request IDs and timing to trace individual conversations or proactive decisions

This makes it possible to audit why an agent responded a certain way or why it posted something to the public feed.

## Summary

The design prioritizes clear trust boundaries above all else. Private data is isolated both in storage (`living_memory`) and in prompt construction. The proactive engine adds a sense of independent life without compromising those boundaries. Scaling concerns are addressed through queuing, cheaper models for routine tasks, and eventual archival of old memories.