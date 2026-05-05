import type { TraceEvent, ResearchProgress } from './types.js';

const MAX_DIARY_ENTRIES = 50;

export class Trace {
   private events: TraceEvent[] = [];

   /** Record an event. Returns the event for chaining. */
   append(event: Omit<TraceEvent, 'timestamp'>): TraceEvent {
      const full: TraceEvent = {
         ...event,
         timestamp: new Date().toISOString(),
      };
      this.events.push(full);
      return full;
   }

   /** Get the N most recent events. */
   recent(count = 10): TraceEvent[] {
      return this.events.slice(-count);
   }

   /** Render bounded diary entries (factual only, no reasoning/CoT). */
   renderDiary(limit: number = MAX_DIARY_ENTRIES): string[] {
      return this.events
         .slice(-limit)
         .map((e) => {
            const parts = [`Step ${String(e.step)}`];
            parts.push(e.action);
            if (e.targetId) parts.push(`target:${e.targetId}`);
            if (e.result) parts.push(`— ${e.result}`);
            if (e.gateChanges?.length) parts.push(`[gates: ${e.gateChanges.join(', ')}]`);
            return parts.join(' ');
         });
   }

   /** Convert to MCP-safe public timeline (no hidden reasoning). */
   publicTimeline(): ResearchProgress[] {
      const timeline: ResearchProgress[] = [];
      for (const e of this.events) {
         switch (e.action) {
            case 'search':
               timeline.push({
                  phase: 'action',
                  actionType: 'search',
                  detail: e.result ?? 'Search executed',
                  timestamp: e.timestamp,
               });
               break;
            case 'extract':
               timeline.push({
                  phase: 'action',
                  actionType: 'extract',
                  detail: e.result ?? 'Extraction completed',
                  timestamp: e.timestamp,
               });
               break;
            case 'evaluate':
               timeline.push({
                  phase: 'action',
                  actionType: 'evaluate',
                  detail: e.result ?? 'Evaluation completed',
                  timestamp: e.timestamp,
               });
               break;
            case 'answer_attempt':
               timeline.push({
                  phase: 'action',
                  actionType: 'answer_attempt',
                  detail: e.result ?? 'Answer attempted',
                  timestamp: e.timestamp,
               });
               break;
            case 'gap_added':
               timeline.push({
                  phase: 'gap_analysis',
                  gaps: [],
               });
               break;
            case 'gap_resolved':
               timeline.push({
                  phase: 'action',
                  actionType: 'gap_resolved',
                  detail: e.result ?? 'Gap resolved',
                  timestamp: e.timestamp,
               });
               break;
            case 'audit':
               timeline.push({
                  phase: 'action',
                  actionType: 'audit',
                  detail: e.result ?? 'Audit completed',
                  timestamp: e.timestamp,
               });
               break;
            case 'warning':
               timeline.push({
                  phase: 'action',
                  actionType: 'warning',
                  detail: e.result ?? '',
                  timestamp: e.timestamp,
               });
               break;
            case 'synthesize':
               timeline.push({
                  phase: 'synthesis',
                  outline: e.result ?? '',
               });
               break;
            default:
               // visit and other actions get a generic action entry
               timeline.push({
                  phase: 'action',
                  actionType: e.action,
                  detail: e.result ?? '',
                  timestamp: e.timestamp,
               });
         }
      }
      return timeline;
   }

   /** Get all raw events (for serialization). */
   getAll(): TraceEvent[] {
      return [...this.events];
   }

   /** Restore from serialized state. */
   load(events: TraceEvent[]): void {
      this.events = events;
   }
}
