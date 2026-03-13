import type { Session } from "../../shared/types";
import { toPercentage } from "./utils";

interface CategoryInfo {
  category: string;
  count: number;
  percentage: number;
  phases: Record<string, number>;
  topNames: string[];
}

export async function getCategories(session: Session): Promise<{ categories: CategoryInfo[] }> {
  const totalEvents = session.trace.traceEvents.length;
  const categories = [...session.indexes.byCategory.entries()]
    .map(([category, events]) => {
      const phases: Record<string, number> = {};
      const nameCounts = new Map<string, number>();

      for (const event of events) {
        phases[event.ph] = (phases[event.ph] ?? 0) + 1;
        nameCounts.set(event.name, (nameCounts.get(event.name) ?? 0) + 1);
      }

      const topNames = [...nameCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([name]) => name);

      return {
        category,
        count: events.length,
        percentage: toPercentage(events.length, totalEvents),
        phases,
        topNames,
      };
    })
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));

  return { categories };
}
