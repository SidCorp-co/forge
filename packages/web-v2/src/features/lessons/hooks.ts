import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { type ConfusionDecision, type LessonAct, lessonsApi } from "./api";

const touched = (projectId: string) => [["lessons", projectId]];

/** The project's lessons, the corrections no lesson holds yet, and the confusions owed a decision. */
export const useLessons = (projectId: string) => useQuery(readOf(["lessons", projectId], () => lessonsApi.list(projectId), 15_000));

/** One calendar month's read (`YYYY-MM`). */
export const useLessonsMonth = (projectId: string, month: string) =>
  useQuery(readOf(["lessons", projectId, "month", month], () => lessonsApi.month(projectId, month)));

/** Approve, edit, reject, retire or keep one lesson. */
export const useLessonAct = (projectId: string) => useWrite((a: LessonAct) => lessonsApi.act(projectId, a), { touches: touched(projectId) });

/** Keep, edit or retire a held lesson on its confusion. */
export const useConfusionDecision = (projectId: string) =>
  useWrite((d: ConfusionDecision) => lessonsApi.decideConfusion(projectId, d), { touches: touched(projectId) });

/** Say a kept correction was not one. */
export const useDismissCorrection = (projectId: string) =>
  useWrite((id: string) => lessonsApi.dismissCorrection(projectId, id), { touches: touched(projectId) });

/** Say a lesson was wrongly applied to one output; the lesson is held until a person decides. */
export const useMarkWronglyApplied = (projectId: string) =>
  useWrite((v: { id: string; reason: string }) => lessonsApi.markWrong(projectId, v.id, v.reason), { touches: touched(projectId) });

/** The lesson lines one chat draws: replies kept as corrections, and lessons each answer applied. */
export const useChatLessonMarks = (projectId: string, conversationId: string) =>
  useQuery(readOf(["lessons", projectId, "chat", conversationId], () => lessonsApi.chat(projectId, conversationId), 15_000));
