---
description: Architecture and engineering rules for the REV-EM project. Use whenever modifying, refactoring, debugging, or adding a feature to REV-EM, especially changes affecting multiple systems, application structure, Supabase, storage, authentication, synchronization, UI architecture, or cross-platform compatibility.
---

# REV-EM Architecture

## Mission

Maintain REV-EM as one coherent, premium, next-generation educational
application.

Before implementing a feature or significant modification:

1. inspect the existing architecture;
2. identify the real files and functions involved;
3. identify components that can be reused;
4. avoid duplicate systems;
5. preserve existing functionality;
6. determine regression risks;
7. prefer extending existing architecture over creating parallel systems.

Do not assume that a component does not exist before searching the repository.

## Core principle

REV-EM must remain:

- modular;
- maintainable;
- performant;
- responsive;
- secure;
- evolvable;
- compatible with GitHub Pages;
- compatible with desktop browsers;
- compatible with mobile;
- compatible with the macOS WKWebView application.

Never create multiple sources of truth for the same data.

Prefer:

one central service
one central state
one clear responsibility

instead of overlapping implementations.

## Existing REV-EM systems

Treat these as important existing systems that must be audited before modification:

- Supabase Auth
- Supabase Database
- Supabase Storage when configured
- user synchronization
- Import Center
- Subjects
- Chapters
- Courses
- PDF handling
- AI assistant
- WebLLM
- Questions libres
- Quiz
- Quiz Flash
- Flashcards
- Planning
- Dashboard
- Progression
- translations
- macOS application
- macOS widget

Never replace an existing system without first proving why the current
architecture cannot be extended safely.

## User data architecture

Keep a strict hierarchy where relevant:

USER
→ SUBJECT
→ CHAPTER
→ COURSE
→ RESOURCES
→ PROGRESSION

All account-specific data must remain isolated by authenticated user.

Never allow account A data to leak into account B.

## Supabase

Never:

- expose service_role in frontend code;
- disable RLS to fix a frontend problem;
- create a second Supabase client without demonstrated need;
- create a migration without demonstrated need;
- make private user files public to simplify access;
- use anonymous global storage for authenticated user data.

When authenticated data is involved, verify:

- auth user ID;
- user_id;
- RLS;
- cloud download;
- cloud upload;
- hydration;
- account switching;
- cross-device behavior.

## localStorage / IndexedDB

Do not treat localStorage as the cloud source of truth for authenticated users.

Local storage may be used for:

- cache;
- preferences;
- temporary state;
- offline support.

User-specific caches must be isolated per account when necessary.

## UI quality

Every visible modification must feel like part of the same product.

REV-EM should feel like a premium educational application, not:

- a generic dashboard;
- an AI-generated template;
- a collection of unrelated cards;
- a student prototype.

Prioritize:

- typography;
- hierarchy;
- spacing;
- clarity;
- restrained visual identity;
- useful micro-interactions;
- responsive behavior;
- accessibility;
- performance.

Avoid:

- excessive cards;
- excessive gradients;
- unnecessary glassmorphism;
- decorative animations;
- duplicated actions;
- visual clutter;
- unnecessary modals.

Animations must support comprehension.

## Performance

Avoid unnecessary:

- network requests;
- database requests;
- DOM re-renders;
- AI calls;
- file parsing;
- state duplication.

Prefer deterministic local processing for tasks that do not require AI.

## Future-proofing

When designing a new feature, consider how it could later support:

- larger numbers of users;
- additional subjects;
- additional AI models;
- RAG;
- REV-EM Knowledge;
- web information;
- native macOS functionality;
- additional platforms.

Do not prematurely implement these systems.

Simply avoid architectures that would block them.

## Regression protection

Before modifying an existing system:

1. identify current behavior;
2. identify dependencies;
3. implement the smallest coherent change;
4. test affected behavior;
5. test important neighboring behavior.

## Testing honesty

Never claim that something works on a real environment if it was only mocked.

Use precise statuses when reporting tests:

PASS

PASS MOCK

NOT TESTED

NOT TESTED REAL SUPABASE

NOT TESTED REAL WEBLLM

NOT TESTED GPU

NOT TESTED MAC

NOT TESTED WKWEBVIEW

A successful compile does not prove functional correctness.

A successful mock does not prove real integration.

## Final reporting

For significant modifications, report:

- architecture before;
- problem identified;
- files modified;
- architecture after;
- tests performed;
- tests not performed;
- regression risks;
- remaining limitations;
- any manual action required from the user.
