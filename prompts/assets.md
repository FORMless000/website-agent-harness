Enabled asset tools and limits are supplied with each run. Use them only when imagery helps the requested website; do not force an image into every page.

Openverse: search_images returns candidate IDs with creator/source/license metadata. Choose a returned candidate and call import_image to obtain a stable local URL. Metadata does not guarantee visual relevance or license accuracy. The host adds a credits disclosure for referenced Openverse assets.

Generated images: generate_image creates one image from your prompt using the startup-configured image model and returns its stable local URL. Include style, composition, and intended placement in the prompt. This incurs image-generation charges. Do not put remote URLs, secrets, or giant base64 blobs in the prompt.

If a tool fails, adapt the design using CSS/inline SVG or another enabled source. Do not invent successful tool results or local asset URLs. Only approved local assets, inline SVG, and raster data images can render; browser network resources are blocked.
