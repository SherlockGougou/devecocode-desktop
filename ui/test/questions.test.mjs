import assert from "node:assert/strict";
import test from "node:test";
import {
  answerForDraft,
  buildQuestionAnswers,
  emptyQuestionDrafts,
  mergeQuestionChanges,
  normalizeQuestionAnswers,
  normalizeQuestionRequest,
  questionAnswersWithNoPreference,
  questionDraftsComplete,
  questionInputQuestions,
  questionAllowsMultipleAnswers,
  questionPageAfterSelection,
  questionRequestMatchesPart,
} from "../test-dist/questions.js";

const single = {
  header: "运行方式",
  question: "请选择接下来的运行方式",
  options: [
    { label: "真机运行", description: "连接设备并自动签名" },
    { label: "模拟器运行", description: "先接受许可协议" },
  ],
};

test("解析 question 工具入参和事件请求", () => {
  assert.deepEqual(questionInputQuestions({ questions: [single] }), [single]);

  const request = normalizeQuestionRequest({
    id: "que_1",
    sessionID: "ses_1",
    questions: [{ ...single, custom: false }],
    tool: { messageID: "msg_1", callID: "call_1" },
  });
  assert.equal(request?.id, "que_1");
  assert.deepEqual(request?.tool, {
    messageID: "msg_1",
    callID: "call_1",
  });
  assert.equal(request?.questions[0].custom, false);
  assert.equal(
    questionRequestMatchesPart(request, {
      sessionID: "ses_1",
      messageID: "msg_1",
      callID: "call_1",
    }),
    true,
  );
  assert.equal(
    questionRequestMatchesPart(request, {
      sessionID: "ses_1",
      messageID: "msg_1",
      callID: "call_2",
    }),
    false,
  );
});

test("单选、多选和自定义回答按问题顺序组装", () => {
  const multiple = {
    ...single,
    header: "附加项",
    multiple: true,
  };
  const questions = [single, multiple];
  const drafts = emptyQuestionDrafts(questions);
  drafts[0].selected = ["真机运行"];
  drafts[1].selected = ["模拟器运行", "真机运行"];
  drafts[1].custom = "  继续使用现有签名  ";

  assert.deepEqual(answerForDraft(single, drafts[0]), ["真机运行"]);
  assert.deepEqual(answerForDraft(multiple, drafts[1]), [
    "模拟器运行",
    "真机运行",
    "继续使用现有签名",
  ]);
  assert.deepEqual(buildQuestionAnswers(questions, drafts), [
    ["真机运行"],
    ["模拟器运行", "真机运行", "继续使用现有签名"],
  ]);
  assert.equal(questionDraftsComplete(questions, drafts), true);
});

test("题干标记兜底多选，并保留显式字段优先级", () => {
  const inferred = {
    ...single,
    question: "鸿蒙端缺少这些 Android 已有能力，本次要补哪些？（可多选）",
  };
  assert.equal(questionAllowsMultipleAnswers(inferred), true);
  assert.equal(
    questionAllowsMultipleAnswers({ ...inferred, multiple: false }),
    false,
  );
  assert.equal(
    questionAllowsMultipleAnswers({ ...single, multiple: true }),
    true,
  );
  assert.equal(questionAllowsMultipleAnswers(single), false);

  const draft = emptyQuestionDrafts([inferred])[0];
  draft.selected = ["备份", "通知"];
  assert.deepEqual(answerForDraft(inferred, draft), ["备份", "通知"]);
});

test("单选后自动前进，多选和最后一题保持当前页", () => {
  const questions = [
    single,
    { ...single, header: "附加项", multiple: true },
    { ...single, header: "备注" },
  ];
  assert.equal(questionPageAfterSelection(0, questions), 1);
  assert.equal(questionPageAfterSelection(1, questions), 1);
  assert.equal(questionPageAfterSelection(2, questions), 2);
  assert.equal(questionPageAfterSelection(0, [single]), 0);
});

test("空答案不完整，异常答案矩阵会被清理", () => {
  const questions = [single];
  const drafts = emptyQuestionDrafts(questions);
  assert.equal(questionDraftsComplete(questions, drafts), false);
  assert.deepEqual(
    normalizeQuestionAnswers([["真机运行", 42, " "], null, "模拟器运行"]),
    [["真机运行"], [], []],
  );
});

test("无偏好只填充未回答的问题", () => {
  const questions = [single, { ...single, header: "备注" }];
  const drafts = emptyQuestionDrafts(questions);
  drafts[0].selected = ["真机运行"];
  assert.deepEqual(questionAnswersWithNoPreference(questions, drafts), [
    ["真机运行"],
    ["无偏好"],
  ]);
});

test("问题快照合并请求期间的新增和解决事件", () => {
  const request = (id) => ({
    id,
    sessionID: "ses_1",
    questions: [single],
  });
  const kept = request("que_kept");
  const resolved = request("que_resolved");
  const added = request("que_added");
  const merged = mergeQuestionChanges(
    [kept, resolved],
    [
      { sequence: 1, kind: "upsert", request: added },
      { sequence: 2, kind: "remove", id: resolved.id },
    ],
    0,
  );
  assert.deepEqual(merged, [kept, added]);

  assert.deepEqual(
    mergeQuestionChanges(
      [kept],
      [{ sequence: 1, kind: "remove", id: kept.id }],
      1,
    ),
    [kept],
  );

  assert.deepEqual(
    mergeQuestionChanges(
      [kept, added],
      [{ sequence: 1, kind: "session", sessionID: "ses_1" }],
      0,
    ),
    [],
  );
  assert.deepEqual(
    mergeQuestionChanges(
      [kept],
      [
        { sequence: 1, kind: "session", sessionID: "ses_1" },
        { sequence: 2, kind: "upsert", request: added },
      ],
      0,
    ),
    [added],
  );
});
