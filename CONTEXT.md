# audit-logs

The company's single, append-only record of who did what, where, and when across all its applications. Administrators review it in the authentication portal; Customers see their own slice of it on an activity page.

## Language

### Events

**Audit Event**:
One immutable record that an Actor did an Action, written by a Source at the moment it happened. Never edited or removed once recorded.
_Avoid_: Log entry, log line, record, activity

**Source**:
The application that wrote an Audit Event: CRMS, HRMS, POS, IMS, Authentication, File storage, Notifications, or Ecommerce.
_Avoid_: System (reserved by the authentication portal for CRMS, HRMS, POS and IMS only), App, Service, Producer

**Module**:
The feature area within a CRMS, HRMS, POS or IMS Source where the Audit Event happened, using the authentication portal's definition. Empty for every other Source.
_Avoid_: Feature, Page, Screen

**Action**:
What happened, named as a dotted phrase such as `user.login`, `access_grant.revoked` or `order.placed`.
_Avoid_: Event type, Operation

### People & things

**Actor**:
Whoever or whatever performed the Action: a portal User, a Customer, or an automated process. Recorded as an opaque id plus a display name captured at that moment.
_Avoid_: User (portal-specific), Performer, Initiator

**Subject**:
The person an Audit Event is about, which decides whose activity history it appears in. Often the Actor, but not always: when an Administrator revokes a User's AccessGrant, the Administrator is the Actor and the affected User is the Subject.
_Avoid_: Owner, Affected user

**Target**:
The thing the Action was performed on, such as an AccessGrant or an Order.
_Avoid_: Resource, Object, Entity

### Visibility

**Description**:
A plain-language sentence for Administrators, written by the Source when the Audit Event happens and kept as written.
_Avoid_: Message, Summary

**Customer description**:
The optional plain-language sentence a Source writes for the Subject Customer. An Audit Event is visible to a Customer only if it has one; without it, it is Administrator-only.
_Avoid_: Public message, Customer-visible flag

### Readers

**Administrator**:
A portal User with the Super Admin or CEO Role (as defined by the authentication portal). Sees every Audit Event, and can filter, search, chart and export them.
_Avoid_: Admin

**Customer**:
A person who shops in the Ecommerce Source, as defined by the Ecommerce Storefront. Sees only Audit Events where they are the Subject and that carry a Customer description.
_Avoid_: User, Account holder
