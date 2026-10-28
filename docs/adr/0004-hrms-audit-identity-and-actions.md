# HRMS audit events use Portal user ids and job_posting.* actions

HRMS Job Posting and Job Template Audit Events use the `job_posting.*` and `job_template.*` Actions rather than mapping them to generic `record.*` Actions, so readers can distinguish drafting, publishing, closing and filling without interpreting metadata. The HRMS catalog retains the four existing record Actions for compatibility; its Module rules remain unchanged.

HRMS producers identify Staff Actors with type `user` and their Portal user id so the Portal's My logs filter can find their activity. Actor ids remain opaque to this service: it does not resolve usernames or enforce Portal identity. The producer rollout must supply the Portal id; older queued events retain their original username identity because the Portal id was not captured. These choices matter in an append-only store, where accepted Actions and captured identities cannot be rewritten later.
