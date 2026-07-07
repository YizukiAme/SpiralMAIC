import type {
  RevisitExamBlueprint,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';
import type { RevisitMessage } from '@/lib/revisit/session';

export interface RevisitJudgeScenario {
  case_id: string;
  description: string;
  repetitions?: number;
  maxQDelta: number;
  maxDimensionDelta: number;
  blueprint: RevisitExamBlueprint;
  transcript: RevisitMessage[];
  pageReports: RevisitPageReport[];
  languageDirective?: string;
}

export interface RevisitJudgeEvalResult {
  case_id: string;
  description: string;
  passed: boolean;
  qValues: number[];
  maxQDelta: number;
  maxDimensionDelta: number;
  reason: string;
  reports: RevisitJudgeReport[];
}
