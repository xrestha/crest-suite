import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register('./hook.mjs', pathToFileURL(import.meta.filename))
