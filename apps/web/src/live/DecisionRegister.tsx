import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DecisionDTO, DecisionsResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';
import type { ChoiceStore } from './blockServices.ts';

/**
 * The decision register: every choice in the document, decided ones first,
 * with the picked option, rationale, evidence and open questions. A
 * projection the API builds from the choice blocks and their recorded
 * decisions; re-read whenever a vote or decision arrives.
 */
export function DecisionRegister(props: { documentId: string; store: ChoiceStore; onClose: () => void }) {
  const version = useSyncExternalStore(props.store.subscribeAll, props.store.version);
  const [decisions, setDecisions] = useState<DecisionDTO[] | null>(null);
  useEffect(() => {
    let live = true;
    // On failure the next change reads again.
    void api(`/api/documents/${encodeURIComponent(props.documentId)}/decisions`)
      .then(async (res) => {
        if (res.ok && live) setDecisions(((await res.json()) as DecisionsResponse).decisions);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.documentId, version]);

  return (
    <aside className="primer-register" aria-label={t('liveEditor.decisions')} data-decision-register="">
      <div className="primer-register-head">
        <strong>{t('liveEditor.decisions')}</strong>
        <button type="button" onClick={props.onClose} aria-label={t('register.close')}>
          ×
        </button>
      </div>
      {decisions === null && <p className="primer-register-empty">{t('register.loading')}</p>}
      {decisions?.length === 0 && <p className="primer-register-empty">{t('register.empty')}</p>}
      <ol>
        {decisions?.map((d) => (
          <li key={d.target.blockId} data-status={d.status}>
            <div className="primer-register-question">{d.question || t('blocks.untitledChoice')}</div>
            {d.decided ? (
              <>
                <div>
                  <strong>{d.decided.label}</strong>
                  <span className="primer-register-meta"> · {t('register.byOn', { name: d.decided.decidedByName, date: new Date(d.decided.decidedAt).toLocaleDateString() })}</span>
                </div>
                {d.decided.changedSinceDecided && (
                  <div className="primer-register-meta">{t('register.changed', { question: d.decided.question })}</div>
                )}
                {d.decided.rationale && <p>{d.decided.rationale}</p>}
                {d.decided.evidence.length > 0 && (
                  <ul>
                    {d.decided.evidence.map((e, i) => (
                      <li key={i}>
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noopener noreferrer">
                            {e.label}
                          </a>
                        ) : e.docId ? (
                          <a href={`/d/${e.docId}`}>{e.label}</a>
                        ) : (
                          e.label
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {d.decided.openQuestions.length > 0 && (
                  <div>
                    <em>{t('blocks.openQuestions')}</em>
                    <ul>
                      {d.decided.openQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className="primer-register-meta">
                {t('register.openTally', { tally: d.options.map((o) => `${o.label || t('blocks.untitledOption')} (${o.votes})`).join(', ') })}
                {d.proposed && ` · ${t('register.proposes', { by: d.proposed.by, label: d.proposed.label })}`}
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
