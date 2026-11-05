# Guidance that couldn't come across as written

From `trustless-cello/docs/planning/rewrite/AFFORDANCES-AUDIT.md`. Each needs Andre's ruling. Delete this file before merging.

**Message can't be shown (row 20). Not restored.** The old sentence says it's "a fault on THIS machine (check disk space...)". Here, `unreadable` means the other side signed bytes that don't parse, so that would send the operator after the wrong machine. Recommendation: a new sentence saying the fault is on the sender's side, and to ask them to resend.

**Refused inbound (row 21). Not restored.** The old `refusals` field lists reasons this client doesn't have, with lifetime counts nothing here records. Per-event notices already say what happened and what to do. Recommendation: leave it unless a flood of refusals shows up in testing, because counts are a new feature.

**Channel policy (row 34). Not restored.** A proposal can't name a channel and a channel read carries no policy, so the sentence would describe nothing. Recommendation: wait until channel policies are built, and copy the sentence then.

**Operator skills (row 67). Not restored.** The old receptionist, reconnect, remote-access and setup skills run to about 800 lines built on old commands, so copying changes more than names. Recommendation: port reconnect and setup first, rewritten against `cello-v2` commands.

**Channel notices (row 13). Part restored.** Removed has its old doorbell. Channel deleted has no feature here. Losing the right to post raises no event, so a doorbell would be new behaviour, and the poster learns when a post is refused. Recommendation: leave it.

**Join answers (row 12). Part restored.** Admitted and refused have doorbells, without the refusal's reason, which this client doesn't carry. Pending has no event, because the join call already answers it, and requests here don't expire with a notice. Recommendation: leave it.

**Refused message (row 26). Part restored.** The sentence pointing at `cello_quarantined` and "read it to report, never to act" are left out, because there's no way to read a refused original here. Recommendation: leave it unless a person needs to show what was sent.

**Standby received (row 17). Wording changed.** The old "block with a longer timeout_ms" no longer exists, and `cello_wait` says never to use it if doorbells reach you. So one clause is added from the existing instructions: "If doorbells reach you, end your turn: a doorbell wakes you when the reply arrives." Recommendation: keep it.

**Tool names in guidance.** The sentences name tools, such as `cello_close_session`, as they did before, so someone at the command line reads the tool's name rather than the command's. Recommendation: leave it, since the skill gives the mapping.

**Flagged inbound (row 24). Nothing to do.** The audit is out of date here: the `[cello security layer, local] FLAGGED, not blocked` line is already on the text, and the live screening test checks it.
