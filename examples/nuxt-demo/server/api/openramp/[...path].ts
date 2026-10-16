// Mounts the OpenRampKit server at /api/openramp. It takes a web-standard Request.
export default defineEventHandler((event) => openramp.handle(toWebRequest(event)))
