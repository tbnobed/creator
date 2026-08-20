Build a production-ready full-stack web application called **OBTV AI Video Studio**.

The application is a professional front-end and orchestration layer for one or more remote **ComfyUI GPU servers**.

The end user should NEVER need to understand ComfyUI nodes, workflows, model filenames, samplers, VAEs, LoRAs, or GPU infrastructure.

The user experience should be:

**Select Character(s) → Select Setting → Enter Prompt → Choose Video Options → Generate → Watch Progress → Preview / Download Result**

The application backend translates those choices into a predefined ComfyUI API workflow and submits it to the appropriate GPU server.

# Primary Goals

Build an attractive professional video-generation application where users can:

1. Maintain a reusable Character Library.
2. Maintain a reusable Setting / Environment Library.
3. Select one or more characters for a generation.
4. Select a setting.
5. Enter a natural-language video prompt.
6. Select duration, resolution, aspect ratio and generation mode.
7. Submit the generation.
8. Upload the required reference assets automatically to ComfyUI.
9. Monitor ComfyUI generation progress.
10. Retrieve the generated video automatically.
11. Preview the completed video in the browser.
12. Download the generated video.
13. Maintain a generation history/gallery.
14. Support MULTIPLE ComfyUI servers and GPUs.
15. Allow administrators to define which ComfyUI workflow is used for each generation mode.

Do not simply iframe ComfyUI.

Build a real application that communicates with ComfyUI through its API.

---

# Technology Stack

Use:

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Node.js
- Express
- PostgreSQL
- Drizzle ORM
- WebSockets
- REST API

Keep frontend and backend cleanly separated.

Use PostgreSQL for persistent application state.

Store uploaded source media and generated outputs using a storage abstraction so we can initially use local filesystem/object storage and later switch to S3-compatible storage without redesigning the application.

---

# Application Layout

Create a professional dark media-production interface.

Main navigation:

- Generate
- Characters
- Settings
- Generations
- GPU Servers
- Workflows
- Admin

The main Generate screen is the centerpiece of the application.

---

# GENERATE SCREEN

Design this like a professional AI video creation tool.

Use a three-column desktop layout.

## Left Panel — Assets

Two tabs:

### Characters

Display character cards containing:

- thumbnail
- character name
- short description
- number of reference images
- optional voice profile
- tags

Allow selection of multiple characters.

A selected character should have a clear active state.

Example:

Maya
Female podcast host
3 reference images

Daniel
Holistic health expert
4 reference images

Support up to 9 reference images in workflows that support that many.

### Settings

Display environment cards.

Examples:

- Wellness Podcast Studio
- Modern Kitchen
- Beach at Sunset
- Corporate Studio
- Living Room
- Forest
- Hospital
- Custom Location

A setting can contain one or more reference images.

Allow exactly one primary setting per generation initially, but design the data model to eventually support multiple environment references.

---

# Center Panel — Prompt / Generation

At the top display selected assets visually:

Characters:

[Maya thumbnail] [Daniel thumbnail]

Setting:

[Podcast Studio thumbnail]

Then provide a large prompt input.

Placeholder:

"Describe what happens in the shot..."

Example:

Maya sits across from Daniel in an elegant wellness podcast studio. Maya leans forward slightly and asks, "So that stillness is actually where the mind begins to rejuvenate?" Daniel listens attentively. Natural conversational body movement, subtle facial expressions, cinematic shallow depth of field.

Add an OPTIONAL Advanced Prompt area.

Allow:

- main prompt
- negative prompt
- camera instructions
- dialogue
- motion instructions
- audio instructions

The UI can combine these into the final workflow prompt.

---

# Generation Controls

Provide simple controls:

## Generation Type

- Reference to Video
- First Frame to Video
- First + Last Frame to Video
- Text to Video
- Image to Video

For MiniMax H3 specifically:

Reference to Video should map to the REF2VA workflow.

First/Last Frame should map to the FL2VA workflow.

Do not hard-code MiniMax H3 throughout the application architecture, though.

Workflows must be configurable so additional models such as Wan, Kling-style workflows, Hunyuan, LTX, Flux image generation, etc. can be added later.

## Duration

Dropdown:

- 3 seconds
- 5 seconds
- 6 seconds
- 8 seconds
- Custom

## Frame Rate

Default:

24 fps

Options:

24
25
30

## Aspect Ratio

Buttons:

16:9
9:16
1:1
4:3
Custom

For common presets automatically calculate appropriate width/height.

Initial recommended H3 presets:

16:9
1376x768

9:16
768x1376

## Quality Mode

- Draft
- Standard
- High Quality

Draft can use Turbo workflows where configured.

Standard and High Quality can use alternate step counts / workflow parameters.

Do NOT globally assume the same step count for every model.

These mappings belong to the workflow template configuration.

## Seed

Default:

Random

Advanced control allows:

- Random
- Fixed seed
- enter numeric seed

---

# GENERATE BUTTON

Large button:

GENERATE VIDEO

Before submitting, show a summary:

Characters
Setting
Workflow
GPU
Resolution
Duration
Estimated queue position if available

When Generate is pressed:

1. Create a Generation Job in the application database.
2. Determine which ComfyUI server should execute it.
3. Upload required character images.
4. Upload required setting images.
5. Upload first/last frame inputs if applicable.
6. Build the ComfyUI API workflow JSON.
7. Replace workflow variables with the user's selections.
8. Submit the workflow.
9. Save the ComfyUI prompt_id.
10. Begin monitoring progress.
11. Update UI in real time.
12. Retrieve output files when complete.
13. Store output metadata.
14. Display completed video.

---

# COMFYUI INTEGRATION

Create a reusable backend service:

`ComfyUIClient`

It should NOT be coupled directly to the React frontend.

Implement methods similar to:

```typescript
class ComfyUIClient {
    getSystemStats()
    getQueue()
    getHistory(promptId)
    getModels(folder)
    uploadImage(file)
    submitWorkflow(workflow, clientId)
    interrupt()
    getOutputFile(filename, subfolder, type)
    connectWebSocket(clientId)
}
```

Support these ComfyUI server capabilities:

- POST `/prompt`
- POST `/upload/image`
- GET `/view`
- GET `/history/{prompt_id}`
- GET `/queue`
- GET `/system_stats`
- GET `/models/{folder}`
- WebSocket `/ws`

Use WebSocket events for live progress whenever possible.

Also implement fallback polling through `/history/{prompt_id}` so jobs still complete if the WebSocket disconnects.

WebSocket connectivity should automatically reconnect.

Do not make successful generation dependent solely on maintaining a WebSocket connection.

---

# MULTIPLE COMFYUI SERVERS

This is critical.

The application must support any number of ComfyUI servers.

Example:

A100 Server

Name:
TBN GPU Server 01

URL:
http://10.x.x.x:8188

GPU:
NVIDIA A100 80GB

Status:
Online

Another server might be:

RTX PRO 6000 Server

Another:

RTX 5090 Server

Each server record should contain:

- id
- display name
- hostname
- API base URL
- websocket URL
- enabled
- priority
- GPU name
- VRAM
- tags
- supported workflows
- current status
- last heartbeat
- current queue size
- active job count
- optional max concurrent jobs

Never expose ComfyUI server URLs or credentials directly to browser clients.

All communication must pass through our application backend.

---

# GPU SERVER DASHBOARD

Build a dashboard showing cards for every ComfyUI server.

Example:

TBN GPU Server 01

NVIDIA A100 80GB

ONLINE

VRAM
18 GB / 80 GB

Queue
2 jobs

Current Job
Maya Podcast Shot 6

Server cards should show:

- Online / Offline
- GPU
- VRAM
- current queue
- active generation
- uptime if available
- supported workflow types

Refresh server information periodically through `/system_stats`.

---

# JOB SCHEDULER

Create a server-selection engine.

Do not simply always send to Server 1.

Each workflow declares compatible server tags.

Example:

MiniMax-H3-A100

requires:

`minimax-h3`
`80gb`
`int8-convrot`

A server can have tags such as:

`a100`
`80gb`
`minimax-h3`
`int8`
`video`

When a generation request arrives:

1. Find online servers that support the requested workflow.
2. Remove disabled or incompatible servers.
3. Prefer the server with the smallest queue.
4. Use server priority as a secondary ranking.
5. Assign the generation.
6. Record which server processed it.

Design the scheduler so smarter scheduling can be implemented later.

---

# CHARACTER LIBRARY

Create a complete Character Library.

Character data model:

```typescript
Character {
    id
    name
    description
    thumbnail
    tags
    promptDescription
    createdAt
    updatedAt
}
```

Character assets:

```typescript
CharacterAsset {
    id
    characterId
    filePath
    fileType
    angle
    description
    sortOrder
}
```

Allow drag-and-drop uploads.

Each character should support multiple reference images.

Examples:

Front
Left profile
Right profile
Medium shot
Full body
Wardrobe reference

Allow users to assign descriptive labels.

Character Edit screen should include:

Name

Description

Prompt Identity Description

Reference Images

Default Voice

Tags

Prompt Identity Description is important.

Example:

"Maya is a woman in her early 30s with shoulder-length dark brown hair, warm brown eyes, olive skin and subtle natural makeup. She wears a cream-colored blouse."

When the character is selected, optionally inject this identity description into the final prompt.

---

# SETTING LIBRARY

Create the same concept for environments.

Setting model:

```typescript
Setting {
    id
    name
    description
    promptDescription
    thumbnail
    tags
}
```

Setting assets:

```typescript
SettingAsset {
    id
    settingId
    filePath
    description
    sortOrder
}
```

Example:

Name:

Wellness Podcast Studio

Prompt description:

"An elegant contemporary wellness podcast studio with warm neutral tones, walnut acoustic panels, soft practical lighting, plants, black broadcast microphones and a shallow-depth-of-field cinematic background."

Reference images:

studio-wide.jpg
maya-angle.jpg
guest-angle.jpg

When selected, the setting description can optionally be injected into the generation prompt.

---

# COMFYUI WORKFLOW TEMPLATE SYSTEM

This is one of the most important parts of the entire application.

Administrators need to be able to upload a ComfyUI **API-format workflow JSON**.

Store the original JSON.

Each workflow template contains:

- name
- description
- generation type
- model family
- API workflow JSON
- compatible server tags
- active/inactive
- version
- expected inputs
- expected outputs

Example:

MiniMax H3 Reference to Video — A100

Model family:

MiniMax H3

Generation mode:

Reference to Video

Compatible tags:

`a100`
`minimax-h3`

The application should NOT rely on fixed ComfyUI node IDs in source code.

Instead create PARAMETER MAPPINGS.

Example mapping:

```json
{
    "prompt": {
        "nodeId": "123",
        "input": "text"
    },

    "width": {
        "nodeId": "87",
        "input": "width"
    },

    "height": {
        "nodeId": "87",
        "input": "height"
    },

    "frames": {
        "nodeId": "92",
        "input": "length"
    },

    "seed": {
        "nodeId": "51",
        "input": "seed"
    },

    "referenceImage1": {
        "nodeId": "24",
        "input": "image"
    }
}
```

The backend uses these mappings to modify a COPY of the workflow before submission.

Never mutate the stored master workflow.

---

# WORKFLOW EDITOR

Build an admin interface allowing a workflow to be uploaded.

Show detected nodes and their inputs.

Allow the administrator to map application parameters to workflow node inputs.

Example UI:

APPLICATION FIELD | COMFY NODE | INPUT

Prompt
→ Node 123
→ text

Reference Character 1
→ Node 24
→ image

Reference Character 2
→ Node 25
→ image

Setting
→ Node 26
→ image

Width
→ Node 87
→ width

Height
→ Node 87
→ height

Frame Count
→ Node 92
→ length

Seed
→ Node 51
→ seed

This allows us to change ComfyUI workflows without changing application source code.

---

# REFERENCE IMAGE MAPPING

Characters may have several images.

When building an H3 REF2VA workflow:

Take the selected characters' ordered reference assets and map them into the workflow's available reference image slots.

Example:

Character Maya

Ref 1 → Node 101
Ref 2 → Node 102
Ref 3 → Node 103

Character Daniel

Ref 1 → Node 104
Ref 2 → Node 105
Ref 3 → Node 106

Setting

Ref 1 → Node 107

If fewer references exist than available slots, leave unused optional references empty or use workflow-specific behavior.

Never duplicate images automatically unless workflow configuration explicitly asks for it.

---

# PROMPT BUILDER

Create a Prompt Builder service.

Final prompt may combine:

Character descriptions

+

Setting description

+

User instruction

+

Camera instructions

+

Dialogue

+

Audio directions

Example internally generated prompt:

```text
CHARACTERS

Maya:
Woman in her early 30s with shoulder-length dark brown hair, warm brown eyes, olive skin, natural makeup, cream blouse.

Daniel:
Man in his early 40s with short dark hair, trimmed beard, charcoal shirt.

SETTING

Elegant contemporary wellness podcast studio with warm neutral lighting, walnut acoustic panels, black broadcast microphones and plants.

ACTION

Maya leans slightly toward Daniel while maintaining relaxed eye contact.

DIALOGUE

Maya says:
"So that stillness is actually where the mind begins to rejuvenate?"

Daniel listens without speaking.

CAMERA

Medium close-up on Maya.
85mm portrait look.
Subtle slow camera movement.
Natural shallow depth of field.

AUDIO

Clean studio dialogue.
Quiet natural room ambience.
No music.
```

Allow administrator control over prompt templates.

Do not permanently hard-code this specific formatting.

---

# GENERATION JOB MODEL

Create:

```typescript
GenerationJob {
    id
    userId

    title

    status

    workflowTemplateId
    comfyServerId
    comfyPromptId

    prompt
    compiledPrompt

    width
    height
    fps
    frameCount
    duration
    seed

    generationMode
    qualityPreset

    progress
    currentNode

    queuedAt
    startedAt
    completedAt
    failedAt

    errorMessage

    createdAt
}
```

Statuses:

DRAFT

UPLOADING

QUEUED

RUNNING

DOWNLOADING

COMPLETED

FAILED

CANCELLED

---

# JOB PROGRESS

While generating, show a dedicated generation card.

Example:

Maya Podcast Shot 6

RUNNING

████████████████░░░░ 78%

MiniMax H3
A100 80GB

Elapsed:
02:41

Current stage:
Video diffusion

Display whatever progress data ComfyUI provides.

If exact overall percentage cannot be determined, show individual node progress and an indeterminate overall state rather than fabricating percentages.

---

# GENERATION HISTORY

Build a beautiful asset gallery.

Each generation card shows:

- video thumbnail
- title
- character names
- setting
- model
- resolution
- duration
- generation time
- date
- status

Clicking opens Generation Details.

---

# GENERATION DETAILS PAGE

Video player at top.

Show:

Prompt

Characters

Setting

Server

Model

Workflow

Seed

Resolution

Duration

FPS

Generation time

Created date

Buttons:

Download

Generate Again

Use Last Frame

Create Continuation

Duplicate Settings

Delete

---

# CONTINUE VIDEO FEATURE

This will be particularly useful for MiniMax H3.

When the user clicks:

CREATE CONTINUATION

The application should:

1. Extract or identify the final frame from the previous video.
2. Make it the starting-frame input for an FL2VA workflow.
3. Carry forward the characters.
4. Carry forward the setting.
5. Carry forward generation parameters.
6. Allow the user to enter the next shot prompt.

This is how we eventually create longer sequences while maintaining continuity.

Design the database model so generations can have:

`parentGenerationId`

This allows us to build shot chains.

---

# PROJECT / SEQUENCE SUPPORT

Add Projects.

A project might be:

"Holistic Health Podcast Reel"

Inside a project:

Shot 1
Shot 2
Shot 3
Shot 4
Shot 5
Shot 6

Each shot can have multiple generated takes.

Example:

Shot 5

Take 1
Take 2
Take 3

Selected Take:
Take 2

This is very important for real production workflows.

Data structure:

Project
→ Sequence
→ Shot
→ Generation Takes

---

# OUTPUT DOWNLOAD

When ComfyUI finishes:

Determine the generated video filename from workflow history/output metadata.

Retrieve the file from ComfyUI.

Store it in application-controlled storage.

Do not require ComfyUI to permanently host generated outputs.

Record:

original ComfyUI output filename
stored application filename
file size
mime type
duration
resolution

Generate a poster frame / thumbnail.

Allow browser playback and direct download.

---

# FAILURE HANDLING

Handle all of these gracefully:

ComfyUI offline

GPU out of memory

workflow validation error

missing model

missing custom node

HTTP timeout

WebSocket disconnect

ComfyUI restart

upload failure

generation interrupted

output retrieval failure

Do not leave jobs permanently stuck as RUNNING.

Use heartbeat/status checks.

Implement sensible timeouts.

Persist job state so an application restart does not lose running generations.

---

# SERVER HEALTH

Every configured ComfyUI server should be checked periodically.

Use `/system_stats` to verify that the server responds.

Record:

status
lastSeen
GPU details
VRAM
software information when available

If offline, remove it from scheduling until healthy again.

---

# SECURITY

Never allow arbitrary users to provide a ComfyUI server URL.

Only administrators can configure servers.

Protect against SSRF.

Server URLs must come from the database and must be administrator-approved.

Validate uploads.

Set upload size limits.

Do not allow executable uploads.

Do not expose filesystem paths.

Do not expose ComfyUI directly through the public frontend.

---

# ADMIN — GPU SERVERS

Administrators should be able to:

Add Server

Edit Server

Disable Server

Test Connection

View GPU Stats

View Queue

See Current Job

Configure Supported Workflows

Configure Priority

Test Connection should immediately call the ComfyUI server and display:

CONNECTED

Server:
tbn-gpusvr01

GPU:
NVIDIA A100 80GB PCIe

VRAM:
80 GB

---

# ADMIN — WORKFLOWS

Allow:

Upload workflow JSON

Name workflow

Assign model family

Assign generation mode

Assign compatible GPU/server tags

Configure UI parameters

Configure ComfyUI node mappings

Test workflow

Duplicate workflow

Create versions

Activate/deactivate workflow

Keep workflow revision history.

---

# MODEL DISCOVERY

Provide an admin utility that can query a ComfyUI server for installed models.

Show categories such as:

diffusion_models

text_encoders

vae

loras

checkpoints

Allow the administrator to see whether a workflow's required models exist on a server.

Eventually show:

READY

or

MISSING MODELS

for each workflow/server combination.

---

# INITIAL MINIMAX H3 CONFIGURATION

Seed the system with two example workflow definitions:

1.

MiniMax H3 REF2VA

Purpose:

Reference-character/image video generation.

2.

MiniMax H3 FL2VA

Purpose:

First/last-frame video generation and clip continuation.

Do not invent actual node IDs.

Create the configuration UI and require the actual exported ComfyUI API workflow JSON to establish node mappings.

---

# API WORKFLOW IMPORT

Provide a page:

Admin → Workflows → Import

User uploads:

`workflow_api.json`

Parse the workflow.

Display nodes in a readable list:

Node ID

Class Type

Title if available

Inputs

Values

Allow clicking a node and assigning application fields.

This is essential.

---

# USER EXPERIENCE

The normal user should NEVER see:

Node IDs

safetensors filenames

CUDA

sampler internals

ComfyUI node graphs

JSON

Instead they see:

Maya

Daniel

Podcast Studio

5 seconds

9:16

High Quality

Generate

The application is effectively a clean abstraction layer over ComfyUI.

---

# VISUAL DESIGN

Design should feel like:

professional post-production software

+

modern AI creative tool

+

broadcast production system

Dark UI.

Large media previews.

Minimal clutter.

Use cards and thumbnails heavily.

Do not make it look like a generic CRUD admin dashboard.

Generate screen should feel creative and visual.

Use:

large video canvas
character thumbnail strips
environment thumbnails
generation controls
prompt composer
progress indicator

Make it responsive but optimize the desktop experience first.

---

# DEVELOPMENT REQUIREMENTS

Use clean modular code.

Suggested modules:

```text
server/
    comfy/
        client.ts
        websocket.ts
        scheduler.ts
        workflow-builder.ts
        workflow-parser.ts

    generation/
        generation-service.ts
        output-service.ts

    storage/
        storage-service.ts

    routes/
        characters.ts
        settings.ts
        generations.ts
        servers.ts
        workflows.ts

client/
    pages/
        Generate.tsx
        Characters.tsx
        Settings.tsx
        Generations.tsx
        GenerationDetails.tsx
        Projects.tsx
        Servers.tsx
        Workflows.tsx

    components/
        CharacterCard.tsx
        SettingCard.tsx
        PromptComposer.tsx
        VideoPreview.tsx
        GenerationProgress.tsx
        ServerStatus.tsx
```

Do not put the entire application in a few giant files.

---

# IMPORTANT ARCHITECTURE RULE

ComfyUI workflow JSON is the source of truth for generation.

Our application does not recreate ComfyUI logic.

It:

uploads media

↓

loads a configured workflow template

↓

injects parameters and uploaded filenames

↓

submits workflow to ComfyUI

↓

tracks execution

↓

retrieves generated outputs

↓

stores them in our media library

This separation is essential.

---

# BUILD ORDER

Implement this incrementally.

## Phase 1

Database schema

Basic UI shell

Character library

Setting library

ComfyUI server configuration

Server connection test

## Phase 2

Workflow JSON import

Workflow parameter mappings

ComfyUI upload integration

ComfyUI `/prompt` submission

Job database

## Phase 3

WebSocket progress

Output retrieval

Video player

Download functionality

Generation history

## Phase 4

Projects

Shots

Takes

Continue-video workflow

Multi-GPU scheduling

## Phase 5

Polish

Admin controls

Error recovery

Performance optimization

Production deployment

Do not fake backend functionality.

Do not use placeholder API calls where working ComfyUI integration can be implemented.

When a capability depends upon workflow-specific node IDs, build the configuration system rather than hardcoding guessed node IDs.

Start by implementing Phase 1 and Phase 2 completely and create a working end-to-end path where:

Character image

+

Setting image

+

Prompt

↓

ComfyUI

↓

Generated video

↓

Application gallery

The first milestone is not complete until a real ComfyUI server can receive the uploaded references, execute an imported API workflow, and return the generated file into the application's Generation History.