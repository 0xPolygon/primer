import { createReactBlockSpec } from '@blocknote/react';
import { usePrimerBlockServices } from './services.ts';

/** Task statuses. */
export const TASK_STATUSES = ['open', 'done'] as const;

/**
 * A tracked task: a checklist item with an assignee (a person or an agent),
 * a due date and a status (BlockNote's prop-driven alert pattern; the text is
 * the task's title). The API indexes task blocks (`doc_tasks`, rebuilt from
 * the document) and announces changes as `task.created` / `task.updated`
 * events, so ticking the box closes the task and wakes its assignee. An
 * assigned agent reports `progress`, shown inline.
 */
export const taskBlock = createReactBlockSpec(
  {
    type: 'task',
    propSchema: {
      assigneeId: { default: '' },
      /** YYYY-MM-DD, or ''. */
      due: { default: '' },
      status: { default: 'open', values: TASK_STATUSES },
      progress: { default: '' },
    },
    content: 'inline',
  },
  {
    render: (props) => <TaskView {...(props as unknown as TaskViewProps)} />,
    // Exports as a checklist item, as BlockNote's own checklist does.
    toExternalHTML: (props) => {
      const p = props.block.props as Record<string, string>;
      return (
        <ul>
          <li>
            <input type="checkbox" defaultChecked={p.status === 'done'} />
            <p ref={props.contentRef} />
          </li>
        </ul>
      );
    },
  },
);

type TaskViewProps = {
  block: { id: string; props: Record<string, string> };
  editor: { isEditable: boolean; updateBlock(id: string, update: { props: Record<string, string> }): unknown };
  contentRef: (node: HTMLElement | null) => void;
};

function TaskView({ block, editor, contentRef }: TaskViewProps) {
  const services = usePrimerBlockServices();
  const p = block.props;
  const done = p.status === 'done';
  const assignees = services?.assignees ?? [];
  const assignee = assignees.find((a) => a.id === p.assigneeId);
  const set = (props: Record<string, string>) => editor.updateBlock(block.id, { props });
  return (
    <div className="primer-task" data-primer-task="" data-status={done ? 'done' : 'open'}>
      <input
        type="checkbox"
        className="primer-task-check"
        aria-label={done ? 'Reopen task' : 'Complete task'}
        checked={done}
        disabled={!editor.isEditable}
        contentEditable={false}
        onChange={(e) => set({ status: e.target.checked ? 'done' : 'open' })}
      />
      <div className="primer-task-title" ref={contentRef} />
      <span className="primer-task-meta" contentEditable={false}>
        {editor.isEditable ? (
          <select
            aria-label="Assignee"
            value={p.assigneeId}
            onChange={(e) => set({ assigneeId: e.target.value })}
          >
            <option value="">Unassigned</option>
            {!assignee && p.assigneeId && <option value={p.assigneeId}>{p.assigneeId}</option>}
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.kind === 'agent' ? `${a.name} (agent)` : a.name}
              </option>
            ))}
          </select>
        ) : (
          p.assigneeId && <span className="primer-task-assignee">{assignee?.name ?? p.assigneeId}</span>
        )}
        {editor.isEditable ? (
          <input type="date" aria-label="Due" value={p.due} onChange={(e) => set({ due: e.target.value })} />
        ) : (
          p.due && <span>due {p.due}</span>
        )}
        {p.progress && !done && <span className="primer-task-progress">{p.progress}</span>}
      </span>
    </div>
  );
}
