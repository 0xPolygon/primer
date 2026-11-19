import { createReactBlockSpec } from '@blocknote/react';

/**
 * A placeholder an agent drafts into (outline-first drafting): it holds the
 * section's intent until the agent fills it with `update`, which replaces the
 * block in place and keeps its id. `runId` names the run writing it, within
 * this document.
 */
export const pendingBlock = createReactBlockSpec(
  {
    type: 'pending',
    propSchema: {
      intent: { default: '' },
      runId: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block }) => (
      <div className="primer-pending" data-primer-pending="" data-run-id={block.props.runId}>
        <span className="primer-pending-label">Writing…</span> {block.props.intent}
      </div>
    ),
  },
);
