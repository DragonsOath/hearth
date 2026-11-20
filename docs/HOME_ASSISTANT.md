# Hearth with Home Assistant and Belle

Home Assistant (and Belle, its voice) is a **relay**: it carries your words to Hearth and
reads the answer back. It makes no decisions about your homelab. Claude, Hearth's AI
operator, investigates and fixes things within your autonomy settings; Hearth enforces
the rules and keeps the record (decision D8 in `PROJECT_STATE.md`).

```text
You:  "Hey Belle, tell Claude Plex is down."
Belle -> Home Assistant -> POST /api/agent/conversations  (your words, as text)
                           Claude investigates and repairs through Hearth's tools
Belle <- Home Assistant <- the answer (or "Claude is on it", then a spoken follow-up)
```

> **Status (2026-10-09):** the Hearth side is built and tested (M7). Home Assistant now
> runs on the home server, and its container reaches Hearth's tailnet address (checked, see
> "Address to use"). The snippets below have **not been applied to it yet**: that changes Home
> Assistant's configuration, which waits for the owner's approval.

## Two directions

- **Hearth reading Home Assistant (built 2026-10-09, read only):** with a long-lived token
  the owner creates in Home Assistant (profile > Security > Long-lived access tokens, named "Dragon
  Control", ideally on a dedicated administrator user) and stores in Secure Vault linked to Home
  Assistant. Ember then sees running state, integrations, repairs, entities,
  automations, devices, the error log, and an entity's logbook. The token itself could do
  anything its user can; Hearth's reader can only make a fixed list of read requests
  (`apps/server/src/apps/homeassistant.ts`). Device control and configuration changes are not
  enabled.
- **Home Assistant (Belle) talking to Hearth:** the relay below.

## 1. An access key

In Hearth: **Settings > Access keys > New key**, name it "Home Assistant", and allow
**Read** and **Talk to the operator** (add **Approve repairs** only if you want to approve by
voice). Copy the key; it is shown once. In Home Assistant's `secrets.yaml`:

```yaml
dragon_control_auth: "Bearer dc_paste_the_key_here"
dragon_control_url_conversations: "https://homeserver.tail1a2b3c.ts.net/api/agent/conversations"
dragon_control_url_status: "https://homeserver.tail1a2b3c.ts.net/api/status"
```

**Address to use (checked 2026-10-09):** Hearth runs on the home server and listens on
`127.0.0.1:7400`, published to the tailnet only by Tailscale Serve. The Home Assistant container
(bridge network `homeassistant_default`) resolves `the home server.tail1a2b3c.ts.net` and reaches it with
valid TLS (health 200 from inside the container). The traffic stays on the home server. Use the address
above: no public exposure, no new port, no change to Hearth's listen address. It
depends on Tailscale running on the home server. Check with:
`curl -H "Authorization: Bearer dc_..." <address>/api/status` from inside the container.

## 2. "Tell Claude ..." (voice to Hearth and back)

`configuration.yaml`:

```yaml
input_text:
  dragon_control_conversation:
    name: Hearth conversation
    max: 80

rest_command:
  dragon_control_ask:
    url: !secret dragon_control_url_conversations
    method: POST
    headers:
      authorization: !secret dragon_control_auth
      content-type: application/json
    # wait: how long Hearth holds the request for Claude's answer (seconds).
    payload: >-
      {"text": {{ text | tojson }}, "source": "voice", "wait": 25
      {%- if conversation_id not in ['', 'unknown'] %}, "conversationId": {{ conversation_id | tojson }}{% endif %}}
    timeout: 30

intent_script:
  AskClaude:
    action:
      - action: rest_command.dragon_control_ask
        data:
          text: "{{ request }}"
          conversation_id: "{{ states('input_text.dragon_control_conversation') }}"
        response_variable: dc
      - if: "{{ dc.status == 200 }}"
        then:
          - action: input_text.set_value
            target:
              entity_id: input_text.dragon_control_conversation
            data:
              value: "{{ dc.content.conversationId }}"
      - stop: ""
        response_variable: dc
    speech:
      text: >-
        {% set r = action_response %}
        {% if r.status != 200 %}I couldn't reach Hearth.
        {% elif r.content.status == 'answered' %}{{ r.content.reply }}
        {% else %}Claude is on it. I'll tell you when it's done.{% endif %}
```

`custom_sentences/en/dragon_control.yaml`:

```yaml
language: "en"
intents:
  AskClaude:
    data:
      - sentences:
          - "tell claude {request}"
          - "ask claude {request}"
lists:
  request:
    wildcard: true
```

Follow-up questions continue the same conversation (the id is kept in
`input_text.dragon_control_conversation`). To start fresh, clear that helper, for example with an
automation after 10 minutes of quiet.

## 3. Spoken follow-ups for longer jobs

When Claude needs longer than the 25 seconds, Hearth sends the answer when it is ready.
In Hearth: **Notifications > Webhook > Set up** with Home Assistant's webhook address,
then under *What goes where* turn on **Webhook** for **Answers from your AI operator** (and, if
you like, **Needs your attention** and **Critical**). Home Assistant automation:

```yaml
automation:
  - alias: "Belle reads Hearth messages"
    triggers:
      - trigger: webhook
        webhook_id: dragon-control-CHANGE-ME-TO-SOMETHING-RANDOM
        local_only: true
        allowed_methods: [POST]
    actions:
      - action: assist_satellite.announce        # the Satellite1, or tts.speak for other speakers
        target:
          entity_id: assist_satellite.CHANGE_ME
        data:
          message: "{{ trigger.json.message }}"
```

The webhook body is `{ source, title, message, severity, link }`; `message` is written to be read
aloud (sample data is announced as such).

## 4. Status on dashboards

```yaml
rest:
  - resource: !secret dragon_control_url_status
    headers:
      authorization: !secret dragon_control_auth
    scan_interval: 60
    sensor:
      - name: "Homelab needs you"
        value_template: "{{ value_json.needsYou }}"
      - name: "Homelab services down"
        value_template: "{{ value_json.servicesDown | length }}"
    binary_sensor:
      - name: "Homelab healthy"
        value_template: "{{ value_json.healthy }}"
```

`GET /api/status` returns `installation, sampleData, healthy, servicesTotal, servicesDown[],
needsYou, openIncidents[{id,title,status}], lastCheckAt`. An incident waiting for approval also
carries `proposedAction` and `approval {fingerprint, expiresAt}`.

Approving with a key that has the approve scope:
`POST /api/incidents/<id>/decision {"decision":"approve","fingerprint":"<approval.fingerprint>"}`.
The fingerprint binds the approval to the exact proposal that was read out; if the proposal
changed or expired, the approval is refused (409) and nothing runs. Each approval works once.
Declining needs no fingerprint.

## Safety

- Home Assistant's key can read status and talk to the operator. It cannot change settings,
  autonomy, security, or open the vault, whatever it sends.
- Claude acts only through Hearth's tools (no shell, files, or web), and Hearth
  checks every repair itself.
- Voice approvals ("yes, go ahead") count only for repairs set to Ask before fixing, and only
  if the key has **Approve repairs**. Anything on the always-ask list needs your fingerprint in
  the app, because a voice can be imitated.
