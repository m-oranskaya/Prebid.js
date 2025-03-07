import {BANNER, VIDEO} from '../src/mediaTypes.js';
import {_each, deepAccess, logError, logWarn, parseSizesInput} from '../src/utils.js';

import {config} from '../src/config.js';
import {getStorageManager} from '../src/storageManager.js';
import {includes} from '../src/polyfill.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';

const BIDDER_CODE = 'gumgum'
const storage = getStorageManager({bidderCode: BIDDER_CODE});
const ALIAS_BIDDER_CODE = ['gg']
const BID_ENDPOINT = `https://g2.gumgum.com/hbid/imp`
const JCSI = { t: 0, rq: 8, pbv: '$prebid.version$' }
const SUPPORTED_MEDIA_TYPES = [BANNER, VIDEO]
const TIME_TO_LIVE = 60
const DELAY_REQUEST_TIME = 1800000; // setting to 30 mins

let invalidRequestIds = {};
let pageViewId = null;

// TODO: potential 0 values for browserParams sent to ad server
function _getBrowserParams(topWindowUrl) {
  const paramRegex = paramName => new RegExp(`[?#&](${paramName}=(.*?))($|&)`, 'i');

  let browserParams = {};
  let topWindow;
  let topScreen;
  let topUrl;
  let ggad;
  let ggdeal;
  let ns;

  function getNetworkSpeed () {
    const connection = window.navigator && (window.navigator.connection || window.navigator.mozConnection || window.navigator.webkitConnection);
    const Mbps = connection && (connection.downlink || connection.bandwidth);
    return Mbps ? Math.round(Mbps * 1024) : null;
  }

  function getOgURL () {
    let ogURL = '';
    const ogURLSelector = "meta[property='og:url']";
    const head = document && document.getElementsByTagName('head')[0];
    const ogURLElement = head.querySelector(ogURLSelector);
    ogURL = ogURLElement ? ogURLElement.content : null;
    return ogURL;
  }

  function stripGGParams (url) {
    const params = [
      'ggad',
      'ggdeal'
    ];

    return params.reduce((result, param) => {
      const matches = url.match(paramRegex(param));
      if (!matches) return result;
      matches[1] && (result = result.replace(matches[1], ''));
      matches[3] && (result = result.replace(matches[3], ''));
      return result;
    }, url);
  }

  try {
    topWindow = global.top;
    topScreen = topWindow.screen;
    topUrl = topWindowUrl || '';
  } catch (error) {
    logError(error);
    return browserParams;
  }

  browserParams = {
    vw: topWindow.innerWidth,
    vh: topWindow.innerHeight,
    sw: topScreen.width,
    sh: topScreen.height,
    pu: stripGGParams(topUrl),
    ce: storage.cookiesAreEnabled(),
    dpr: topWindow.devicePixelRatio || 1,
    jcsi: JSON.stringify(JCSI),
    ogu: getOgURL()
  };

  ns = getNetworkSpeed();
  if (ns) {
    browserParams.ns = ns;
  }

  ggad = (topUrl.match(paramRegex('ggad')) || [0, 0, 0])[2];
  if (ggad) browserParams[isNaN(ggad) ? 'eAdBuyId' : 'adBuyId'] = ggad;

  ggdeal = (topUrl.match(paramRegex('ggdeal')) || [0, 0, 0])[2];
  if (ggdeal) browserParams.ggdeal = ggdeal;

  return browserParams;
}

function getWrapperCode(wrapper, data) {
  return wrapper.replace('AD_JSON', window.btoa(JSON.stringify(data)))
}

function _getDigiTrustQueryParams(userId) {
  let digiTrustId = userId.digitrustid && userId.digitrustid.data;
  // Verify there is an ID and this user has not opted out
  if (!digiTrustId || (digiTrustId.privacy && digiTrustId.privacy.optout)) {
    return {};
  }
  return {
    dt: digiTrustId.id
  };
}

/**
 * Serializes the supply chain object according to IAB standards
 * @see https://github.com/InteractiveAdvertisingBureau/openrtb/blob/master/supplychainobject.md
 * @param {Object} schainObj supply chain object
 * @returns {string}
 */
function _serializeSupplyChainObj(schainObj) {
  let serializedSchain = `${schainObj.ver},${schainObj.complete}`;

  // order of properties: asi,sid,hp,rid,name,domain
  schainObj.nodes.map(node => {
    serializedSchain += `!${encodeURIComponent(node['asi'] || '')},`;
    serializedSchain += `${encodeURIComponent(node['sid'] || '')},`;
    serializedSchain += `${encodeURIComponent(node['hp'] || '')},`;
    serializedSchain += `${encodeURIComponent(node['rid'] || '')},`;
    serializedSchain += `${encodeURIComponent(node['name'] || '')},`;
    serializedSchain += `${encodeURIComponent(node['domain'] || '')}`;
  })

  return serializedSchain;
}

/**
 * Determines whether or not the given bid request is valid.
 *
 * @param {BidRequest} bid The bid params to validate.
 * @return boolean True if this is a valid bid, and false otherwise.
 */
function isBidRequestValid(bid) {
  const {
    params,
    adUnitCode
  } = bid;
  const legacyParamID = params.inScreen || params.inScreenPubID || params.inSlot || params.ICV || params.video || params.inVideo;
  const id = legacyParamID || params.slot || params.native || params.zone || params.pubID;

  if (invalidRequestIds[id]) {
    logWarn(`[GumGum] Please check the implementation for ${id} for the placement ${adUnitCode}`);
    return false;
  }

  switch (true) {
    case !!(params.zone): break;
    case !!(params.pubId): break;
    case !!(params.inScreen): break;
    case !!(params.inScreenPubID): break;
    case !!(params.inSlot): break;
    case !!(params.ICV): break;
    case !!(params.video): break;
    case !!(params.inVideo): break;
    case !!(params.videoPubID): break;
    default:
      logWarn(`[GumGum] No product selected for the placement ${adUnitCode}, please check your implementation.`);
      return false;
  }

  if (params.bidfloor && !(typeof params.bidfloor === 'number' && isFinite(params.bidfloor))) {
    logWarn('[GumGum] bidfloor must be a Number');
    return false;
  }

  return true;
}

/**
 * Renames vid params from mediatypes.video keys
 * @param {Object} attributes
 * @returns {Object}
 */
function _getVidParams(attributes) {
  const {
    minduration: mind,
    maxduration: maxd,
    linearity: li,
    startdelay: sd,
    placement: pt,
    protocols = [],
    playerSize = []
  } = attributes;
  const sizes = parseSizesInput(playerSize);
  const [viw, vih] = sizes[0] && sizes[0].split('x');
  let pr = '';

  if (protocols.length) {
    pr = protocols.join(',');
  }

  return {
    mind,
    maxd,
    li,
    sd,
    pt,
    pr,
    viw,
    vih
  };
}

/**
 * Gets bidfloor
 * @param {Object} mediaTypes
 * @param {Number} bidfloor
 * @param {Object} bid
 * @returns {Number} floor
 */
function _getFloor(mediaTypes, staticBidFloor, bid) {
  const curMediaType = Object.keys(mediaTypes)[0] || 'banner';
  const bidFloor = { floor: 0, currency: 'USD' };

  if (typeof bid.getFloor === 'function') {
    const { currency, floor } = bid.getFloor({
      mediaType: curMediaType,
      size: '*'
    });
    floor && (bidFloor.floor = floor);
    currency && (bidFloor.currency = currency);

    if (staticBidFloor && floor && currency === 'USD') {
      bidFloor.floor = Math.max(staticBidFloor, parseFloat(floor));
    }
  } else if (staticBidFloor) {
    bidFloor.floor = staticBidFloor
  }

  return bidFloor;
}

/**
 * loops through bannerSizes array to get greatest slot dimensions
 * @param {number[][]} sizes
 * @returns {number[]}
 */
function getGreatestDimensions(sizes) {
  let maxw = 0;
  let maxh = 0;
  let greatestVal = 0;
  sizes.forEach(bannerSize => {
    let [width, height] = bannerSize;
    let greaterSide = width > height ? width : height;
    if ((greaterSide > greatestVal) || (greaterSide === greatestVal && width >= maxw && height >= maxh)) {
      greatestVal = greaterSide;
      maxw = width;
      maxh = height;
    }
  });

  return [maxw, maxh];
}

function getEids(userId) {
  const idProperties = [
    'uid',
    'eid',
    'lipbid'
  ];

  return Object.keys(userId).reduce(function (eids, provider) {
    const eid = userId[provider];
    switch (typeof eid) {
      case 'string':
        eids[provider] = eid;
        break;

      case 'object':
        const idProp = idProperties.filter(prop => eid.hasOwnProperty(prop));
        idProp.length && (eids[provider] = eid[idProp[0]]);
        break;
    }
    return eids;
  }, {});
}

/**
 * Make a server request from the list of BidRequests.
 *
 * @param {validBidRequests[]} - an array of bids
 * @return ServerRequest Info describing the request to the server.
 */
function buildRequests(validBidRequests, bidderRequest) {
  const bids = [];
  const gdprConsent = bidderRequest && bidderRequest.gdprConsent;
  const uspConsent = bidderRequest && bidderRequest.uspConsent;
  const timeout = config.getConfig('bidderTimeout');
  const topWindowUrl = bidderRequest && bidderRequest.refererInfo && bidderRequest.refererInfo.page;
  _each(validBidRequests, bidRequest => {
    const {
      bidId,
      mediaTypes = {},
      params = {},
      schain,
      transactionId,
      userId = {},
      ortb2Imp,
      adUnitCode = ''
    } = bidRequest;
    const { currency, floor } = _getFloor(mediaTypes, params.bidfloor, bidRequest);
    const eids = getEids(userId);
    const gpid = deepAccess(ortb2Imp, 'ext.data.pbadslot') || deepAccess(ortb2Imp, 'ext.data.adserver.adslot');
    let sizes = [1, 1];
    let data = {};

    const date = new Date();
    const lt = date.getTime();
    const to = date.getTimezoneOffset();

    // ADTS-174 Removed unnecessary checks to fix failing test
    data.lt = lt;
    data.to = to;

    // ADTS-169 add adUnitCode to requests
    if (adUnitCode) data.aun = adUnitCode

    // ADTS-134 Retrieve ID envelopes
    for (const eid in eids) data[eid] = eids[eid];

    // ADJS-1024 & ADSS-1297 & ADTS-175
    gpid && (data.gpid = gpid);

    if (mediaTypes.banner) {
      sizes = mediaTypes.banner.sizes;
    } else if (mediaTypes.video) {
      sizes = mediaTypes.video.playerSize;
      data = _getVidParams(mediaTypes.video);
    }

    if (pageViewId) {
      data.pv = pageViewId;
    }

    if (floor) {
      data.fp = floor;
      data.fpc = currency;
    }

    if (params.iriscat && typeof params.iriscat === 'string') {
      data.iriscat = params.iriscat;
    }

    if (params.irisid && typeof params.irisid === 'string') {
      data.irisid = params.irisid;
    }

    if (params.zone || params.pubId) {
      params.zone ? (data.t = params.zone) : (data.pubId = params.pubId);

      data.pi = 2; // inscreen
      // override pi if the following is found
      if (params.slot) {
        const [maxw, maxh] = getGreatestDimensions(sizes);
        data.maxw = maxw;
        data.maxh = maxh;
        data.si = params.slot;
        data.pi = 3;
        data.bf = sizes.reduce((acc, curSlotDim) => `${acc}${acc && ','}${curSlotDim[0]}x${curSlotDim[1]}`, '');
      } else if (params.native) {
        data.ni = params.native;
        data.pi = 5;
      } else if (mediaTypes.video) {
        data.pi = mediaTypes.video.linearity === 2 ? 6 : 7; // invideo : video
      } else if (params.product && params.product.toLowerCase() === 'skins') {
        data.pi = 8;
      }
    } else { // legacy params
      data = { ...data, ...handleLegacyParams(params, sizes) }
    }

    if (gdprConsent) {
      data.gdprApplies = gdprConsent.gdprApplies ? 1 : 0;
    }
    if (data.gdprApplies) {
      data.gdprConsent = gdprConsent.consentString;
    }
    if (uspConsent) {
      data.uspConsent = uspConsent;
    }
    if (schain && schain.nodes) {
      data.schain = _serializeSupplyChainObj(schain);
    }

    bids.push({
      id: bidId,
      tmax: timeout,
      tId: transactionId,
      pi: data.pi,
      selector: params.selector,
      sizes,
      url: BID_ENDPOINT,
      method: 'GET',
      data: Object.assign(data, _getBrowserParams(topWindowUrl), _getDigiTrustQueryParams(userId))
    })
  });
  return bids;
}

function handleLegacyParams(params, sizes) {
  const data = {};
  if (params.inScreenPubID) {
    data.pubId = params.inScreenPubID;
    data.pi = 2;
  }
  if (params.inScreen) {
    data.t = params.inScreen;
    data.pi = 2;
  }
  if (params.inSlot) {
    const [maxw, maxh] = getGreatestDimensions(sizes);
    data.maxw = maxw;
    data.maxh = maxh;
    data.si = params.inSlot;
    data.pi = 3;
    data.bf = sizes.reduce((acc, curSlotDim) => `${acc}${acc && ','}${curSlotDim[0]}x${curSlotDim[1]}`, '');
  }
  if (params.ICV) {
    data.ni = params.ICV;
    data.pi = 5;
  }
  if (params.videoPubID) {
    data.pubId = params.videoPubID;
    data.pi = 7;
  }
  if (params.video) {
    data.t = params.video;
    data.pi = 7;
  }
  if (params.inVideo) {
    data.t = params.inVideo;
    data.pi = 6;
  }
  return data;
}

/**
 * Unpack the response from the server into a list of bids.
 *
 * @param {*} serverResponse A successful response from the server.
 * @return {Bid[]} An array of bids which were nested inside the server.
 */
function interpretResponse(serverResponse, bidRequest) {
  const bidResponses = []
  const serverResponseBody = serverResponse.body

  if (!serverResponseBody || serverResponseBody.err) {
    const data = bidRequest.data || {};
    const id = data.si || data.ni || data.t || data.pubId;
    const delayTime = serverResponseBody ? serverResponseBody.err.drt : DELAY_REQUEST_TIME;
    invalidRequestIds[id] = { productId: data.pi, timestamp: new Date().getTime() };

    setTimeout(() => {
      !!invalidRequestIds[id] && delete invalidRequestIds[id];
    }, delayTime);
    logWarn(`[GumGum] Please check the implementation for ${id}`);
  }

  const defaultResponse = {
    ad: {
      price: 0,
      id: 0,
      markup: '',
      width: 0,
      height: 0
    },
    pag: {
      pvid: 0
    },
    meta: {
      adomain: [],
      mediaType: ''
    }
  }
  const {
    ad: {
      price: cpm,
      id: creativeId,
      markup,
      cur,
      width: responseWidth,
      height: responseHeight,
      maxw,
      maxh
    },
    cw: wrapper,
    pag: {
      pvid
    },
    jcsi,
    meta: {
      adomain: advertiserDomains,
      mediaType: type
    }
  } = Object.assign(defaultResponse, serverResponseBody);
  let data = bidRequest.data || {};
  let product = data.pi;
  let mediaType = (product === 6 || product === 7) ? VIDEO : BANNER;
  let isTestUnit = (product === 3 && data.si === 9);
  let metaData = {
    advertiserDomains: advertiserDomains || [],
    mediaType: type || mediaType
  };
  let sizes = parseSizesInput(bidRequest.sizes);

  if (maxw && maxh) {
    sizes = [`${maxw}x${maxh}`];
  } else if (product === 5 && includes(sizes, '1x1')) {
    sizes = ['1x1'];
  } else if (product === 2 && includes(sizes, '1x1')) {
    const requestSizesThatMatchResponse = (bidRequest.sizes && bidRequest.sizes.reduce((result, current) => {
      const [ width, height ] = current;
      if (responseWidth === width || responseHeight === height) result.push(current.join('x'));
      return result
    }, [])) || [];
    sizes = requestSizesThatMatchResponse.length ? requestSizesThatMatchResponse : parseSizesInput(bidRequest.sizes)
  }

  let [width, height] = sizes[0].split('x');

  if (jcsi) {
    serverResponseBody.jcsi = JCSI
  }

  // update Page View ID from server response
  pageViewId = pvid

  if (creativeId) {
    bidResponses.push({
      // dealId: DEAL_ID,
      // referrer: REFERER,
      ad: wrapper ? getWrapperCode(wrapper, Object.assign({}, serverResponseBody, { bidRequest })) : markup,
      ...(mediaType === VIDEO && { ad: markup, vastXml: markup }),
      mediaType,
      cpm: isTestUnit ? 0.1 : cpm,
      creativeId,
      currency: cur || 'USD',
      height,
      netRevenue: true,
      requestId: bidRequest.id,
      ttl: TIME_TO_LIVE,
      width,
      meta: metaData
    })
  }
  return bidResponses
}

/**
 * Register the user sync pixels which should be dropped after the auction.
 *
 * @param {SyncOptions} syncOptions Which user syncs are allowed?
 * @param {ServerResponse[]} serverResponses List of server's responses.
 * @return {UserSync[]} The user syncs which should be dropped.
 */
function getUserSyncs(syncOptions, serverResponses) {
  const responses = serverResponses.map((response) => {
    return (response.body && response.body.pxs && response.body.pxs.scr) || []
  })
  const userSyncs = responses.reduce(function (usersyncs, response) {
    return usersyncs.concat(response)
  }, [])
  const syncs = userSyncs.map((sync) => {
    return {
      type: sync.t === 'f' ? 'iframe' : 'image',
      url: sync.u
    }
  })
  return syncs;
}

export const spec = {
  code: BIDDER_CODE,
  aliases: ALIAS_BIDDER_CODE,
  isBidRequestValid,
  buildRequests,
  interpretResponse,
  getUserSyncs,
  supportedMediaTypes: SUPPORTED_MEDIA_TYPES
}
registerBidder(spec)
