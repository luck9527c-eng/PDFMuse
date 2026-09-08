import type { ScheduleBackgroundJobInput } from "../shared/contracts.js";
import type { StoredAppConfig } from "./config-store.js";

type EmbeddingJobInput = Omit<ScheduleBackgroundJobInput, "kind">;

type EmbeddingJobSchedulerDependencies = {
  loadConfig: () => Promise<StoredAppConfig>;
  schedule: (input: ScheduleBackgroundJobInput) => unknown;
  reportError?: (message: string, error: unknown) => void;
};

export async function scheduleEmbeddingJobIfConfigured(
  input: EmbeddingJobInput,
  dependencies: EmbeddingJobSchedulerDependencies,
) {
  let config: StoredAppConfig;
  try {
    config = await dependencies.loadConfig();
  } catch (error) {
    (dependencies.reportError ?? console.error)("读取嵌入模型配置失败，已跳过语义索引。", error);
    return false;
  }

  if (!config.embedding?.baseUrl.trim() || !config.embedding.model.trim()) return false;

  try {
    dependencies.schedule({ ...input, kind: "embedding" });
    return true;
  } catch (error) {
    (dependencies.reportError ?? console.error)("创建语义索引任务失败，已继续使用全文检索。", error);
    return false;
  }
}
