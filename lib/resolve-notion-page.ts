import { parsePageId } from 'notion-utils'
import { ExtendedRecordMap } from 'notion-types'

import * as acl from './acl'
import { pageUrlAdditions, environment, site } from './config'
import { db } from './db'
import { getPage, UNAUTHORISED } from './notion'
import { getSiteMap } from './get-site-map'
import { getExposedRouteIds, getInversePageUrlOverrides, getPageUrlOverrides } from './get-exposed-routes'

export async function resolveNotionPage(domain: string, rawPageId?: string) {
  let pageId: string
  let recordMap: ExtendedRecordMap | typeof UNAUTHORISED
  const exposedRouteIds = await getExposedRouteIds();

  // TODO: let's not query twice (:
  const pageUrlOverrides = await getPageUrlOverrides();
  const inversePageUrlOverrides = await getInversePageUrlOverrides();

  if (rawPageId && rawPageId !== 'index') {
    pageId = parsePageId(rawPageId)

    if (!pageId) {
      // check if the site configuration provides an override or a fallback for
      // the page's URI
      const override =
        pageUrlOverrides[rawPageId] || pageUrlAdditions[rawPageId]

      if (override) {
        pageId = parsePageId(override)
      }
    }

    const useUriToPageIdCache = true
    const cacheKey = `uri-to-page-id:${domain}:${environment}:${rawPageId}`
    // TODO: should we use a TTL for these mappings or make them permanent?
    // const cacheTTL = 8.64e7 // one day in milliseconds
    const cacheTTL = undefined // disable cache TTL

    if (!pageId && useUriToPageIdCache) {
      try {
        // check if the database has a cached mapping of this URI to page ID
        pageId = await db.get(cacheKey)

        // console.log(`redis get "${cacheKey}"`, pageId)
      } catch (err) {
        // ignore redis errors
        console.warn(`redis error get "${cacheKey}"`, err.message)
      }
    }

    if (pageId) {
      recordMap = await getPage(pageId, exposedRouteIds)
    } else {
      // handle mapping of user-friendly canonical page paths to Notion page IDs
      // e.g., /developer-x-entrepreneur versus /71201624b204481f862630ea25ce62fe
      const siteMap = await getSiteMap()
      pageId = siteMap?.canonicalPageMap[rawPageId]

      if (pageId) {
        // TODO: we're not re-using the page recordMap from siteMaps because it is
        // cached aggressively
        // recordMap = siteMap.pageMap[pageId]

        recordMap = await getPage(pageId, exposedRouteIds)

        if (useUriToPageIdCache) {
          try {
            // update the database mapping of URI to pageId
            await db.set(cacheKey, pageId, cacheTTL)

            // console.log(`redis set "${cacheKey}"`, pageId, { cacheTTL })
          } catch (err) {
            // ignore redis errors
            console.warn(`redis error set "${cacheKey}"`, err.message)
          }
        }
      } else {
        // note: we're purposefully not caching URI to pageId mappings for 404s
        return {
          error: {
            message: `Not found "${rawPageId}"`,
            statusCode: 404
          }
        }
      }
    }
  } else {
    pageId = site.rootNotionPageId

    console.log(site)
    recordMap = await getPage(pageId, exposedRouteIds)
  }

  if (recordMap === UNAUTHORISED) return {
    error: {
      statusCode: 404,
      message: `You are currently not authorised to view '${pageId}'.`
    }
  }

  const props = { site, recordMap, pageId, exposedRouteIds, inversePageUrlOverrides }
  return { ...props, ...(await acl.pageAcl(props)) }
}
