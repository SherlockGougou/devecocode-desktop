import { useEffect, useRef, useState } from "react";
import {
  allowsCustomQuestionAnswer,
  buildQuestionAnswers,
  emptyQuestionDrafts,
  questionDraftsComplete,
  questionAllowsMultipleAnswers,
  questionAnswersWithNoPreference,
  questionPageAfterSelection,
  type QuestionDraft,
} from "../questions";
import { useApp } from "../store";
import type { QuestionInfo, QuestionRequest } from "../types";
import { Icon } from "./Icon";

/**
 * 待回答的 `question` 占用 Composer 位置，避免用户继续向正在等待输入的 Agent 发消息。
 * Composer 本身保持挂载，只是由父级隐藏，因此未发送的草稿不会丢。
 */
export default function QuestionDock({ request }: { request: QuestionRequest }) {
  const replyQuestion = useApp((s) => s.replyQuestion);
  const stopQuestion = useApp((s) => s.stopQuestion);
  const busy = useApp((s) => s.questionBusy[request.id]);
  const stopping = useApp((s) =>
    s.sessionID ? s.stoppingSessions[s.sessionID] === true : false,
  );
  const questions = request.questions;
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    emptyQuestionDrafts(questions),
  );
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const customRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPage(0);
    setDrafts(emptyQuestionDrafts(questions));
    setExpanded(true);
    setMenuOpen(false);
  }, [request.id]);

  useEffect(() => {
    if (page < questions.length) return;
    setPage(Math.max(0, questions.length - 1));
  }, [page, questions.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const question = questions[page] ?? questions[0];
  const draft = drafts[page] ?? {
    selected: [],
    custom: "",
    customActive: false,
  };
  const complete = questionDraftsComplete(questions, drafts);
  const answeredCount = buildQuestionAnswers(questions, drafts).filter(
    (answer) => answer.length > 0,
  ).length;
  const disabled = Boolean(busy) || stopping;
  const customAllowed =
    question && allowsCustomQuestionAnswer(question);
  const multiple = question
    ? questionAllowsMultipleAnswers(question)
    : false;

  useEffect(() => {
    if (draft.customActive) customRef.current?.focus();
  }, [page, draft.customActive]);

  if (!question) return null;

  const updateDraft = (update: (draft: QuestionDraft) => QuestionDraft) => {
    setDrafts((current) =>
      current.map((item, index) => (index === page ? update(item) : item)),
    );
  };

  const selectOption = (value: QuestionInfo, label: string) => {
    updateDraft((current) => {
      if (questionAllowsMultipleAnswers(value)) {
        const selected = current.selected.includes(label)
          ? current.selected.filter((item) => item !== label)
          : [...current.selected, label];
        return { ...current, selected };
      }
      return { selected: [label], custom: "", customActive: false };
    });
    setPage((current) =>
      questionPageAfterSelection(current, questions),
    );
  };

  const toggleCustom = () => {
    updateDraft((current) => {
      if (multiple) {
        return {
          ...current,
          customActive: !current.customActive,
          custom: current.customActive ? "" : current.custom,
        };
      }
      return {
        selected: [],
        customActive: true,
        custom: current.custom,
      };
    });
  };

  const submit = async () => {
    if (disabled || !complete) return;
    await replyQuestion(request.id, buildQuestionAnswers(questions, drafts));
  };

  const submitNoPreference = async () => {
    if (disabled) return;
    const answers = questionAnswersWithNoPreference(questions, drafts);
    await replyQuestion(request.id, answers);
  };

  const stopGeneration = async () => {
    setMenuOpen(false);
    await stopQuestion(request.id);
  };

  return (
    <section className="question-dock" aria-label="Agent 正在等待回答">
      <div className={`question-dock-box${expanded ? " expanded" : " compact"}`}>
        <header className="question-dock-head">
          <div className="question-dock-title-wrap">
            <span className="question-dock-header">{question.header}</span>
            <div className="question-dock-title">{question.question}</div>
          </div>
          <div className="question-dock-nav">
            {questions.length > 1 && (
              <>
                <button
                  type="button"
                  className="question-dock-icon-btn"
                  title="上一个问题"
                  aria-label="上一个问题"
                  disabled={page === 0 || disabled}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                >
                  <Icon name="chevron-right" size={14} className="flip-x" />
                </button>
                <span className="question-dock-counter">
                  {page + 1}/{questions.length}
                </span>
                <button
                  type="button"
                  className="question-dock-icon-btn"
                  title="下一个问题"
                  aria-label="下一个问题"
                  disabled={page === questions.length - 1 || disabled}
                  onClick={() =>
                    setPage((current) =>
                      Math.min(questions.length - 1, current + 1),
                    )
                  }
                >
                  <Icon name="chevron-right" size={14} />
                </button>
                <span className="question-dock-nav-separator" />
              </>
            )}
            <button
              type="button"
              className="question-dock-icon-btn"
              title={expanded ? "收起问题面板" : "展开问题面板"}
              aria-label={expanded ? "收起问题面板" : "展开问题面板"}
              onClick={() => setExpanded((current) => !current)}
            >
              <Icon name="maximize" size={14} />
            </button>
          </div>
        </header>

        <div className="question-dock-body">
          <div className="question-dock-hint">
            {multiple ? "可选择多个回答" : "选择一个回答"}
          </div>
          <div
            className={`question-dock-options ${multiple ? "multiple" : "single"}`}
            role={multiple ? "group" : "radiogroup"}
            aria-label={question.header}
          >
            {question.options.map((option) => {
              const selected = draft.selected.includes(option.label);
              return (
                <button
                  type="button"
                  key={option.label}
                  className={`question-dock-option${selected ? " selected" : ""}`}
                  role={multiple ? "checkbox" : "radio"}
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => selectOption(question, option.label)}
                >
                  <span className="question-dock-check">
                    {selected && (
                      <Icon name="check" size={11} strokeWidth={2.4} />
                    )}
                  </span>
                  <span className="question-dock-option-label">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="question-dock-option-description">
                      {option.description}
                    </span>
                  )}
                </button>
              );
            })}
            {customAllowed && (
              <button
                type="button"
                className={`question-dock-option question-dock-custom-toggle${draft.customActive ? " selected" : ""}`}
                role={multiple ? "checkbox" : "radio"}
                aria-checked={draft.customActive}
                disabled={disabled}
                onClick={toggleCustom}
              >
                <span className="question-dock-check">
                  {draft.customActive && (
                    <Icon name="pencil" size={11} strokeWidth={2.2} />
                  )}
                </span>
                <span className="question-dock-option-label">输入其他答案</span>
              </button>
            )}
          </div>
          {customAllowed && draft.customActive && (
            <textarea
              ref={customRef}
              className="question-dock-custom-input"
              rows={2}
              value={draft.custom}
              disabled={disabled}
              placeholder="输入你的回答…"
              aria-label={`${question.header}的自定义回答`}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  custom: event.target.value,
                  customActive: true,
                }))
              }
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  complete
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          )}
        </div>

        <footer className="question-dock-foot">
          <span className="question-dock-status" aria-live="polite">
            {stopping
              ? "正在停止生成…"
              : busy
                ? "正在提交回答…"
                : complete
                  ? "所有问题已回答"
                  : `${answeredCount}/${questions.length} 已回答`}
          </span>
          <button
            type="button"
            className="primary-btn small question-dock-submit"
            disabled={disabled || !complete}
            onClick={() => void submit()}
          >
            提交回答
          </button>
          <div className="question-dock-nopref" ref={menuRef}>
            <button
              type="button"
              className="question-dock-nopref-main"
              disabled={disabled}
              title="未回答的问题按“无偏好”提交"
              onClick={() => void submitNoPreference()}
            >
              无偏好
            </button>
            <button
              type="button"
              className="question-dock-nopref-toggle"
              aria-label="更多问题操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={disabled}
              onClick={() => setMenuOpen((current) => !current)}
            >
              <Icon name="chevron-down" size={12} />
            </button>
            {menuOpen && (
              <div className="question-dock-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="question-dock-menu-danger"
                  onClick={() => void stopGeneration()}
                >
                  <Icon name="stop" size={13} />
                  停止生成
                </button>
              </div>
            )}
          </div>
        </footer>
      </div>
    </section>
  );
}
