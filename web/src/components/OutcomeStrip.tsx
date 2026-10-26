import { Fragment, useMemo } from 'react';
import type { ModelRequest, ToolCall } from '../../../src/core/model.js';
import { type Outcome, sessionOutcome, type TestVerdict } from '../../../src/shared/outcome.js';
import type { OpenSession } from '../data/store';
import { type MessageKey, type Params, translateParts, useI18n } from '../i18n';
import { subtreeIds } from '../lib/agents';
import type { Navigate } from '../router';
import { useUi } from '../ui';
import css from './OutcomeStrip.module.css';

interface Props {
  open: OpenSession;
  /** The breadcrumb's agent: its work and its sub-agents' is what the strip says. */
  agentId: string;
  navigate: Navigate;
}

/** One link of the strip: its texts, read one after the other, and where it goes. */
interface Item {
  id: string;
  texts: { k: MessageKey; params: Params }[];
  title: string;
  verdict?: TestVerdict;
  failed?: boolean;
  go(): void;
}

const TESTS: Record<TestVerdict, MessageKey> = {
  passed: 'outcome.testsPassed',
  failed: 'outcome.testsFailed',
  running: 'outcome.testsRunning',
  unknown: 'outcome.testsUnknown',
};
const MARK: Partial<Record<TestVerdict, string>> = { passed: '✓', failed: '✗' };

/** The files edited, created and deleted as one link's texts; the first names the files. */
function fileTexts(files: Outcome['files']): Item['texts'] {
  const texts: Item['texts'] = [];
  const add = (n: number, first: MessageKey, next: MessageKey) => {
    if (n > 0) texts.push({ k: texts.length === 0 ? first : next, params: { n } });
  };
  add(files.edited, 'files.headEdited', 'files.headEdited');
  add(files.created, 'outcome.filesCreated', 'files.headCreated');
  add(files.deleted, 'outcome.filesDeleted', 'files.headDeleted');
  return texts;
}

/** A text with its count in the mono face and a test verdict's mark in its colour. */
function Words({ k, params, verdict }: { k: MessageKey; params: Params; verdict?: TestVerdict }) {
  const { locale } = useI18n();
  return (
    <>
      {translateParts(locale, k, params, ['n', 'mark']).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <Fragment key={i}>{p}</Fragment>
        ) : p.param === 'mark' ? (
          // The words say the verdict; the mark is for the eye.
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <span key={i} className={css.mark} data-verdict={verdict} aria-hidden="true">
            {p.value}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <span key={i} className="figure">
            {p.value}
          </span>
        ),
      )}
    </>
  );
}

/**
 * What the selected agent and its sub-agents did, on one line under the summary bar: "12 files
 * edited · 3 created · tests ✓ 4 runs, last passed · 2 commits · 1 question · 3 failures". Each
 * part is a link: the files to the Files tab; the tests, the commits and the questions to the
 * last such call, the failures to the first, in the execution chain with its card open. Not
 * drawn when there is nothing to say.
 */
export function OutcomeStrip({ open, agentId, navigate }: Props) {
  const { t } = useI18n();
  const { setFollow } = useUi();
  const ids = useMemo(() => subtreeIds(open, agentId), [open, agentId]);
  const o = useMemo(() => sessionOutcome(open, ids), [open, ids]);

  // Lands on the call in the execution chain with its card open, as the Files tab's links do.
  const toCall = (tool: ToolCall) => {
    setFollow(false);
    navigate({
      tab: 'flow',
      agentId: tool.agentId,
      turnId: open.requests.get(tool.requestId)?.turnId ?? null,
      requestId: tool.requestId,
      card: `tool:${tool.id}`,
    });
  };
  // A failed model call says why on its response card.
  const toResponse = (request: ModelRequest) => {
    setFollow(false);
    navigate({
      tab: 'flow',
      agentId: request.agentId,
      turnId: request.turnId,
      requestId: request.id,
      card: 'response',
    });
  };

  const items: Item[] = [];
  const files = fileTexts(o.files);
  if (files.length > 0)
    items.push({
      id: 'files',
      texts: files,
      title: t('outcome.toFiles'),
      go: () => navigate({ tab: 'files' }),
    });
  const { tests, commits, questions, failures } = o;
  if (tests)
    items.push({
      id: 'tests',
      texts: [
        { k: TESTS[tests.verdict], params: { n: tests.runs, mark: MARK[tests.verdict] ?? '' } },
      ],
      verdict: tests.verdict,
      title: t('outcome.toTests'),
      go: () => toCall(tests.last),
    });
  if (commits)
    items.push({
      id: 'commits',
      texts: [{ k: 'outcome.commits', params: { n: commits.count } }],
      title: commits.message
        ? t('outcome.lastCommit', { m: commits.message })
        : t('outcome.toCommit'),
      go: () => toCall(commits.last),
    });
  if (questions)
    items.push({
      id: 'questions',
      texts: [{ k: 'outcome.questions', params: { n: questions.count } }],
      title: t('outcome.toQuestion'),
      go: () => toCall(questions.last),
    });
  if (failures)
    items.push({
      id: 'failures',
      texts: [{ k: 'outcome.failures', params: { n: failures.count } }],
      failed: true,
      title: t('outcome.toFailure'),
      go: () =>
        failures.first.kind === 'tool'
          ? toCall(failures.first.tool)
          : toResponse(failures.first.request),
    });
  if (items.length === 0) return null;

  return (
    <section className={css.strip} aria-label={t('outcome.title')}>
      {items.map((item, i) => (
        <Fragment key={item.id}>
          {i > 0 && <span className={css.sep}> · </span>}
          <button
            type="button"
            className={css.item}
            data-failed={item.failed || undefined}
            title={item.title}
            onClick={item.go}
          >
            {item.texts.map((text, j) => (
              <Fragment key={text.k}>
                {j > 0 && <span className={css.sep}> · </span>}
                <Words k={text.k} params={text.params} verdict={item.verdict} />
              </Fragment>
            ))}
          </button>
        </Fragment>
      ))}
    </section>
  );
}
