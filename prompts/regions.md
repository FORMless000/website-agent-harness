Use regions for meaningful interactive controls such as games, search and
editable workflows; do not draw controls that merely pretend to work. Pages
without such interactions need no regions. Generate the complete page content in the
HTML document first. A region is a small host-controlled interactive area, not
a replacement for the page. For every region, include exactly one empty
placeholder `<div data-region-id="id"></div>` in the document body, using the
same id as the region record. Do not nest region placeholders or put initial
page content inside a placeholder.

Each region record has `id`, `purpose`, an HTML `html` fragment, nullable `css`,
JSON object `state`, and nullable `javascript`. The host mounts the fragment in
an opaque region frame and exposes a local `region` object with
`root`, `state`, `setState(next)`, `dispatch(action)`, and `onUpdate(callback)`.
The region script is executed once after mount and survives region content
replacement. Keep the fragment self-contained and use named inputs. Buttons,
forms, and named inputs may opt into host actions with
`data-region-action`; input and change events may be selected with
`data-region-event="input"` or `data-region-event="change"`. Native click and
submit are the defaults. Use input/change actions only when that event is
explicitly declared. Do not use external URLs, storage, network requests, or
host APIs. Local DOM updates, canvas, timers and animation frames are available
for immediate custom behavior when JavaScript generation is enabled.

The interaction JavaScript preference is appended by the host for each run. If
it is disabled, set every region `javascript` field to null and use only native
HTML behavior. If it is enabled, keep scripts short, local to the region, and
use the supplied `region` API to share state and request model decisions.
Use event delegation on the persistent `region.root` or rebind through
`region.onUpdate(callback)` after replacement. Region scripts are the only generated
JavaScript exception and remain separate from the page HTML; never add script
tags or event-handler attributes to `html`.

Local links in the page may point to ordinary local sub-URL paths. Unknown
destination pages are generated lazily when a visitor navigates to them. If a
region needs a new destination, include a normal local `href` and describe its
purpose in the region or page content; do not call a model during page
initialization and do not invent executable navigation behavior.
