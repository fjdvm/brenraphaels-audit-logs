# HRMS Training and Performance use dedicated Actions

HRMS Training and Performance Audit Events use dedicated Actions (`training.*`, `training_material.*`, `kpi.*`, `weight_set.*`, `performance_period.*`, `non_working_date.*`, `attendance.*`, `attendance_day.*`, `rating.saved`, `development_need.flagged`) under the new `Training` and `Performance` Modules, rather than the generic `record.*` Actions, so readers can tell a reschedule from a cancellation or an excused day from an absence without interpreting metadata. As with ADR-0004, the existing `record.*`, `job_posting.*` and `job_template.*` Actions stay accepted.

HRMS writes one Audit Event per Staff action, so a single action that touches many records (for example importing attendance or assigning several Employees) is one event whose metadata carries ids and counts, not one event per record. `description` is stored verbatim and metadata must not hold Staff-typed free text.

The `record.updated` events that Performance already wrote when submitting and reopening records are left as stored. The store is append-only (ADR-0002), so they cannot be rewritten, and readers continue to find them under `record.updated`. New submit and reopen activity is not covered by these Actions. The catalog must be deployed before HRMS enables its producer side, because an older catalog rejects the new Actions and the events stay queued.
