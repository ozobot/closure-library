// Copyright 2016 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview
 * JavaScript support for client-side CSS sanitization.
 *
 * @author danesh@google.com (Danesh Irani)
 * @author mikesamuel@gmail.com (Mike Samuel)
 */

goog.provide('goog.html.sanitizer.CssSanitizer');

goog.require('goog.array');
goog.require('goog.dom');
goog.require('goog.dom.TagName');
goog.require('goog.html.CssSpecificity');
goog.require('goog.html.SafeStyle');
goog.require('goog.html.SafeStyleSheet');
goog.require('goog.html.SafeUrl');
goog.require('goog.html.sanitizer.noclobber');
goog.require('goog.html.uncheckedconversions');
goog.require('goog.object');
goog.require('goog.string');
goog.require('goog.userAgent');
goog.require('goog.userAgent.product');


/**
 * The set of characters that need to be normalized inside url("...").
 * We normalize newlines because they are not allowed inside quoted strings,
 * normalize quote characters, angle-brackets, and asterisks because they
 * could be used to break out of the URL or introduce targets for CSS
 * error recovery.  We normalize parentheses since they delimit unquoted
 * URLs and calls and could be a target for error recovery.
 * @const @private {!RegExp}
 */
goog.html.sanitizer.CssSanitizer.NORM_URL_REGEXP_ = /[\n\f\r\"\'()*<>]/g;


/**
 * The replacements for NORM_URL_REGEXP.
 * @private @const {!Object<string, string>}
 */
goog.html.sanitizer.CssSanitizer.NORM_URL_REPLACEMENTS_ = {
  '\n': '%0a',
  '\f': '%0c',
  '\r': '%0d',
  '"': '%22',
  '\'': '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2a',
  '<': '%3c',
  '>': '%3e'
};


/**
 * A regular expression to match each selector in a CSS rule. Selectors are
 * separated by commas, but can have strings within them (e.g. foo[name="bar"])
 * that can contain commas and escaped quotes.
 * @private {?RegExp}
 */
goog.html.sanitizer.CssSanitizer.SELECTOR_REGEX_ =
    // Don't even evaluate it on older browsers (IE8 and IE9), it throws a
    // syntax error and we don't use it anyway.
    !(goog.userAgent.IE && document.documentMode < 10) ?
    new RegExp(
        '\\s*' +              // Discard initial space
            '([^\\s\'",]+' +  // Beginning of the match. Anything but a comma,
                              // spaces or a string delimiter. This is the only
                              // non-optional component of the regex.
            '[^\'",]*' +      // Spaces are fine afterwards (e.g. "a > b").
            ('(' +  // A series of optional strings with matching delimiters
                    // that can contain anything, and optional non-quoted text
                    // without commas.
             '(\'([^\'\\r\\n\\f\\\\]|\\\\[^])*\')|' +  // Optional single-quoted
                                                       // string.
             '("([^"\\r\\n\\f\\\\]|\\\\[^])*")|' +     // Optional double-quoted
                                                       // string.
             '[^\'",]' +  // Optional non-string content.
             ')*') +      // String and non-string
                          // content can come in any
                          // order.
            ')',          // End of the match.
        'g') :
    null;


/**
 * Normalizes a character for use in a url() directive.
 * @param {string} ch Character to be normalized.
 * @return {?string} Normalized character.
 * @private
 */
goog.html.sanitizer.CssSanitizer.normalizeUrlChar_ = function(ch) {
  return goog.html.sanitizer.CssSanitizer.NORM_URL_REPLACEMENTS_[ch] || null;
};


/**
 * Constructs a safe URI from a given URI and prop using a given uriRewriter
 * function.
 * @param {string} uri URI to be sanitized.
 * @param {string} propName Property name which contained the URI.
 * @param {?function(string, string):?goog.html.SafeUrl} uriRewriter A URI
 *    rewriter that returns a goog.html.SafeUrl.
 * @return {?string} Safe URI for use in CSS.
 * @private
 */
goog.html.sanitizer.CssSanitizer.getSafeUri_ = function(
    uri, propName, uriRewriter) {
  if (!uriRewriter) {
    return null;
  }
  var safeUri = uriRewriter(uri, propName);
  if (safeUri &&
      goog.html.SafeUrl.unwrap(safeUri) != goog.html.SafeUrl.INNOCUOUS_STRING) {
    return 'url("' +
        goog.html.SafeUrl.unwrap(safeUri).replace(
            goog.html.sanitizer.CssSanitizer.NORM_URL_REGEXP_,
            goog.html.sanitizer.CssSanitizer.normalizeUrlChar_) +
        '")';
  }
  return null;
};


/**
 * Used to detect the beginning of the argument list of a CSS property value
 * containing a CSS function call.
 * @private @const {string}
 */
goog.html.sanitizer.CssSanitizer.FUNCTION_ARGUMENTS_BEGIN_ = '(';


/**
 * Used to detect the end of the argument list of a CSS property value
 * containing a CSS function call.
 * @private @const {string}
 */
goog.html.sanitizer.CssSanitizer.FUNCTION_ARGUMENTS_END_ = ')';


/**
 * Allowed CSS functions
 * @const @private {!Array<string>}
 */
goog.html.sanitizer.CssSanitizer.ALLOWED_FUNCTIONS_ = [
  'rgb',
  'rgba',
  'alpha',
  'rect',
  'image',
  'linear-gradient',
  'radial-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'cubic-bezier',
  'matrix',
  'perspective',
  'rotate',
  'rotate3d',
  'rotatex',
  'rotatey',
  'steps',
  'rotatez',
  'scale',
  'scale3d',
  'scalex',
  'scaley',
  'scalez',
  'skew',
  'skewx',
  'skewy',
  'translate',
  'translate3d',
  'translatex',
  'translatey',
  'translatez'
];


/**
 * Removes a vendor prefix from a property name.
 * @param {string} propName A property name.
 * @return {string} A property name without vendor prefixes.
 * @private
 */
goog.html.sanitizer.CssSanitizer.withoutVendorPrefix_ = function(propName) {
  // http://stackoverflow.com/a/5411098/20394 has a fairly extensive list
  // of vendor prefices. Blink has not declared a vendor prefix distinct from
  // -webkit- and http://css-tricks.com/tldr-on-vendor-prefix-drama/ discusses
  // how Mozilla recognizes some -webkit- prefixes.
  // http://wiki.csswg.org/spec/vendor-prefixes talks more about
  // cross-implementation, and lists other prefixes.
  return propName.replace(
      /^-(?:apple|css|epub|khtml|moz|mso?|o|rim|wap|webkit|xv)-(?=[a-z])/i, '');
};


/**
 * Sanitizes the value for a given a browser-parsed CSS value.
 * @param {string} propName A property name.
 * @param {string} propValue Value of the property as parsed by the browser.
 * @param {function(string, string):?goog.html.SafeUrl=} opt_uriRewriter A URI
 *     rewriter that returns an unwrapped goog.html.SafeUrl.
 * @return {?string} Sanitized property value or null.
 * @private
 */
goog.html.sanitizer.CssSanitizer.sanitizeProperty_ = function(
    propName, propValue, opt_uriRewriter) {
  var outputPropValue = goog.string.trim(propValue);
  if (outputPropValue == '') {
    return null;
  }

  if (goog.string.caseInsensitiveStartsWith(outputPropValue, 'url(')) {
    // Urls are rewritten according to the policy implemented in
    // opt_uriRewriter.
    // TODO(pelizzi): use HtmlSanitizerUrlPolicy for opt_uriRewriter.
    if (!opt_uriRewriter) {
      return null;
    }
    // TODO(danesh): Check if we need to resolve this URI.
    var uri = goog.string.stripQuotes(
        outputPropValue.substring(4, outputPropValue.length - 1), '"\'');

    return goog.html.sanitizer.CssSanitizer.getSafeUri_(
        uri, propName, opt_uriRewriter);
  } else if (outputPropValue.indexOf('(') > 0) {
    // Functions are filtered through a whitelist. Nesting whitelisted functions
    // is not supported.
    if (goog.string.countOf(
            outputPropValue,
            goog.html.sanitizer.CssSanitizer.FUNCTION_ARGUMENTS_BEGIN_) > 1 ||
        !(goog.array.contains(
              goog.html.sanitizer.CssSanitizer.ALLOWED_FUNCTIONS_,
              outputPropValue
                  .substring(
                      0,
                      outputPropValue.indexOf(goog.html.sanitizer.CssSanitizer
                                                  .FUNCTION_ARGUMENTS_BEGIN_))
                  .toLowerCase()) &&
          goog.string.endsWith(
              outputPropValue,
              goog.html.sanitizer.CssSanitizer.FUNCTION_ARGUMENTS_END_))) {
      // TODO(b/34222379): Handle functions that may need recursing or that may
      // appear in the middle of a string. For now, just allow functions which
      // aren't nested.
      return null;
    }
    return outputPropValue;
  } else {
    // Everything else is allowed.
    return outputPropValue;
  }
};


/**
 * Sanitizes a {@link CSSStyleSheet}.
 * @param {!CSSStyleSheet} cssStyleSheet
 * @param {?string} containerId An ID to restrict the scope of the rules being
 *     sanitized. If null, no restriction is applied.
 * @param {function(string, string):?goog.html.SafeUrl|undefined} uriRewriter A
 *     URI rewriter that returns a goog.html.SafeUrl.
 * @return {!goog.html.SafeStyleSheet}
 * @private
 */
goog.html.sanitizer.CssSanitizer.sanitizeStyleSheet_ = function(
    cssStyleSheet, containerId, uriRewriter) {
  var sanitizedRules = [];
  var cssRules = goog.html.sanitizer.CssSanitizer.getOnlyStyleRules_(
      goog.array.toArray(cssStyleSheet.cssRules));
  goog.array.forEach(cssRules, function(cssRule) {
    if (containerId && !/[a-zA-Z][\w-:\.]*/.test(containerId)) {
      // Sanity check on the element ID that will confine the new CSS rules.
      throw new Error('Invalid container id');
    }
    if (containerId && goog.userAgent.product.IE &&
        document.documentMode == 10 && /\\['"]/.test(cssRule.selectorText)) {
      // If a container ID was specified, drop selectors with escaped quotes in
      // strings on IE 10 due to a regex bug.
      return;
    }
    // If a container ID was specified, restrict all selectors in this rule to
    // be descendants of the node with such an ID. Use a regex to exclude commas
    // within selector strings.
    var scopedSelector = containerId ?
        cssRule.selectorText.replace(
            goog.html.sanitizer.CssSanitizer.SELECTOR_REGEX_,
            '#' + containerId + ' $1') :
        cssRule.selectorText;
    sanitizedRules.push(goog.html.SafeStyleSheet.createRule(
        scopedSelector,
        goog.html.sanitizer.CssSanitizer.sanitizeInlineStyle(
            cssRule.style, uriRewriter)));
  });
  return goog.html.SafeStyleSheet.concat(sanitizedRules);
};


/**
 * Used to filter out at-rules like @media, @font, etc. Currently, none of these
 * are supported.
 * @param {!Array<!CSSRule>} cssRules
 * @return {!Array<!CSSStyleRule>}
 * @private
 */
// TODO(pelizzi): some of these at-rules are safe, consider adding partial
// support for them.
goog.html.sanitizer.CssSanitizer.getOnlyStyleRules_ = function(cssRules) {
  return /** @type {!Array<!CSSStyleRule>} */ (
      goog.array.filter(cssRules, function(cssRule) {
        return cssRule instanceof CSSStyleRule ||
            cssRule.type == CSSRule.STYLE_RULE;
      }));
};


/**
 * Sanitizes the contents of a STYLE tag.
 * @param {string} textContent The textual content of the STYLE tag.
 * @param {?string=} opt_containerId The ID of a node that will contain the
 *     STYLE tag that includes the sanitized content, to restrict the effects of
 *     the rules being sanitized to descendants of this node.
 * @param {function(string, string):?goog.html.SafeUrl=} opt_uriRewriter A URI
 *     rewriter that returns a goog.html.SafeUrl.
 * @return {!goog.html.SafeStyleSheet}
 * @supported IE 10+, Chrome 26+, Firefox 22+, Safari 7.1+, Opera 15+. On IE10,
 *     support for escaped quotes inside quoted strings (e.g. `a[name="it\'s"]`)
 *     is unreliable, and some (but not all!) rules containing these are
 *     silently dropped.
 */
goog.html.sanitizer.CssSanitizer.sanitizeStyleSheetString = function(
    textContent, opt_containerId, opt_uriRewriter) {
  var styleTag =
      goog.html.sanitizer.CssSanitizer.safeParseHtmlAndGetInertElement(
          '<style>' + textContent + '</style>');
  if (styleTag == null) {
    return goog.html.SafeStyleSheet.EMPTY;
  }
  var containerId = opt_containerId != undefined ? opt_containerId : null;
  return goog.html.sanitizer.CssSanitizer.sanitizeStyleSheet_(
      styleTag.sheet, containerId, opt_uriRewriter);
};


/**
 * Returns an inert DOM tree produced by parsing the provided html using
 * DOMParser. "Inert" here means that merely parsing the string won't execute
 * scripts or load images. If you attach this tree to a non-inert document, it
 * will execute these side effects! In this package we prefer using the TEMPLATE
 * tag over DOMParser to produce inert trees, but at least on Chrome the inert
 * STYLE tag does not have a CSSStyleSheet object attached to it.
 * @param {string} html
 * @return {?Element}
 */
goog.html.sanitizer.CssSanitizer.safeParseHtmlAndGetInertElement = function(
    html) {
  if ((goog.userAgent.IE && !goog.userAgent.isVersionOrHigher(10)) ||
      typeof goog.global.DOMParser != 'function') {
    return null;
  }
  var parser = new DOMParser();
  return parser
      .parseFromString(
          '<html><head></head><body>' + html + '</body></html>', 'text/html')
      .body.children[0];
};


/**
 * Sanitizes an inline style attribute. Short-hand attributes are expanded to
 * their individual elements. Note: The sanitizer does not output vendor
 * prefixed styles.
 * @param {?CSSStyleDeclaration} cssStyle A CSS style object.
 * @param {function(string, string):?goog.html.SafeUrl=} opt_uriRewriter A URI
 *     rewriter that returns a goog.html.SafeUrl.
 * @return {!goog.html.SafeStyle} A sanitized inline cssText.
 */
goog.html.sanitizer.CssSanitizer.sanitizeInlineStyle = function(
    cssStyle, opt_uriRewriter) {
  if (!cssStyle) {
    return goog.html.SafeStyle.EMPTY;
  }

  var cleanCssStyle = document.createElement('div').style;
  var cssPropNames =
      goog.html.sanitizer.CssSanitizer.getCssPropNames_(cssStyle);

  for (var i = 0; i < cssPropNames.length; i++) {
    var propName =
        goog.html.sanitizer.CssSanitizer.withoutVendorPrefix_(cssPropNames[i]);
    if (!goog.html.sanitizer.CssSanitizer.isDisallowedPropertyName_(propName)) {
      var propValue =
          goog.html.sanitizer.noclobber.getCssPropertyValue(cssStyle, propName);

      var sanitizedValue = goog.html.sanitizer.CssSanitizer.sanitizeProperty_(
          propName, propValue, opt_uriRewriter);
      if (sanitizedValue != null) {
        goog.html.sanitizer.noclobber.setCssProperty(
            cleanCssStyle, propName, sanitizedValue);
      }
    }
  }
  return goog.html.uncheckedconversions
      .safeStyleFromStringKnownToSatisfyTypeContract(
          goog.string.Const.from('Output of CSS sanitizer'),
          cleanCssStyle.cssText || '');
};


/**
 * Sanitizes inline CSS text and returns it as a SafeStyle object. When adequate
 * browser support is not available, such as for IE9 and below, a
 * SafeStyle-wrapped empty string is returned.
 * @param {string} cssText CSS text to be sanitized.
 * @param {function(string, string):?goog.html.SafeUrl=} opt_uriRewriter A URI
 *     rewriter that returns a goog.html.SafeUrl.
 * @return {!goog.html.SafeStyle} A sanitized inline cssText.
 */
goog.html.sanitizer.CssSanitizer.sanitizeInlineStyleString = function(
    cssText, opt_uriRewriter) {
  // same check as in goog.html.sanitizer.HTML_SANITIZER_SUPPORTED_
  if (goog.userAgent.IE && document.documentMode < 10) {
    return new goog.html.SafeStyle();
  }

  var div = goog.html.sanitizer.CssSanitizer
      .createInertDocument_()
      .createElement('DIV');
  div.style.cssText = cssText;
  return goog.html.sanitizer.CssSanitizer.sanitizeInlineStyle(
      div.style, opt_uriRewriter);
};


/**
 * Converts rules in STYLE tags into style attributes on the tags they apply to.
 * Modifies the provided DOM subtree in-place.
 * @param {!Element} element
 * @package
 */
goog.html.sanitizer.CssSanitizer.inlineStyleRules = function(element) {
  // Note that Webkit used to offer the perfect function for the job:
  // getMatchedCSSRules. Unfortunately, it was never supported cross-browser and
  // is deprecated now. On the other hand, getComputedStyle cannot be used to
  // differentiate property values that are set by a style sheet from those set
  // by a style attribute or default values. This algorithm with
  // O(nr_of_elements * nr_of_rules) complexity that has to manually sort
  // selectors by specificity is the best we can do.

  // Extract all rules from STYLE tags found in the subtree.
  /** @type {!Array<!HTMLStyleElement>} */
  var styleTags =
      goog.html.sanitizer.noclobber.getElementsByTagName(element, 'STYLE');
  var cssRules = goog.array.concatMap(styleTags, function(styleTag) {
    return goog.array.toArray(
        goog.html.sanitizer.noclobber.getElementStyleSheet(styleTag).cssRules);
  });
  cssRules = goog.html.sanitizer.CssSanitizer.getOnlyStyleRules_(cssRules);
  // Sort the rules by descending specificity.
  cssRules.sort(function(a, b) {
    var aSpecificity = goog.html.CssSpecificity.getSpecificity(a.selectorText);
    var bSpecificity = goog.html.CssSpecificity.getSpecificity(b.selectorText);
    return -goog.array.compare3(aSpecificity, bSpecificity);
  });
  // For each element, apply the matching rules to the element style attribute.
  // If a property is already explicitly defined, do not update it. This
  // guarantees that the rule with selectors with the highest priority (or the
  // properties defined in the style attribute itself) have precedence over
  // lower priority ones.
  var subTreeWalker = document.createTreeWalker(
      element, NodeFilter.SHOW_ELEMENT, null /* filter */,
      false /* entityReferenceExpansion */);
  var currentElement;
  while (currentElement = /** @type {!Element} */ (subTreeWalker.nextNode())) {
    goog.array.forEach(cssRules, function(rule) {
      if (!goog.html.sanitizer.noclobber.elementMatches(
              currentElement, rule.selectorText)) {
        return;
      }
      if (!rule.style) {
        return;
      }
      goog.html.sanitizer.CssSanitizer.mergeStyleDeclarations_(
          currentElement, rule.style);
    });
  }
  // Delete the STYLE tags.
  goog.array.forEach(styleTags, goog.dom.removeNode);
};


/**
 * Merges style properties from {@code styleDeclaration} into
 * {@code element.style}.
 * @param {!Element} element
 * @param {!CSSStyleDeclaration} styleDeclaration
 * @private
 */
goog.html.sanitizer.CssSanitizer.mergeStyleDeclarations_ = function(
    element, styleDeclaration) {
  var existingPropNames =
      goog.html.sanitizer.CssSanitizer.getCssPropNames_(element.style);
  var newPropNames =
      goog.html.sanitizer.CssSanitizer.getCssPropNames_(styleDeclaration);

  goog.array.forEach(newPropNames, function(propName) {
    if (existingPropNames.indexOf(propName) >= 0) {
      // This was either a property set by the style attribute or a stylesheet
      // rule with a higher priority. Leave the existing value.
      return;
    }
    var propValue = goog.html.sanitizer.noclobber.getCssPropertyValue(
        styleDeclaration, propName);
    goog.html.sanitizer.noclobber.setCssProperty(
        element.style, propName, propValue);
  });
};


/**
 * Creates an DOM Document object that will not execute scripts or make
 * network requests while parsing HTML.
 * @return {!Document}
 * @private
 */
goog.html.sanitizer.CssSanitizer.createInertDocument_ = function() {
  // Documents created using window.document.implementation.createHTMLDocument()
  // use the same custom component registry as their parent document. This means
  // that parsing arbitrary HTML can result in calls to user-defined JavaScript.
  // This is worked around by creating a template element and its content's
  // document. See https://github.com/cure53/DOMPurify/issues/47.
  var doc = document;
  if (typeof HTMLTemplateElement === 'function') {
    doc =
        goog.dom.createElement(goog.dom.TagName.TEMPLATE).content.ownerDocument;
  }
  return doc.implementation.createHTMLDocument('');
};


/**
 * Provides a cross-browser way to get a CSS property names.
 * @param {!CSSStyleDeclaration} cssStyle A CSS style object.
 * @return {!Array<string>} CSS property names.
 * @private
 */
goog.html.sanitizer.CssSanitizer.getCssPropNames_ = function(cssStyle) {
  var propNames = [];
  if (goog.isArrayLike(cssStyle)) {
    // Gets property names via item().
    // https://drafts.csswg.org/cssom/#dom-cssstyledeclaration-item
    propNames = goog.array.toArray(cssStyle);
  } else {
    // In IE8 and other older browsers we have to iterate over all the property
    // names. We skip cssText because it contains the unsanitized CSS, which
    // defeats the purpose.
    propNames = goog.object.getKeys(cssStyle);
    goog.array.remove(propNames, 'cssText');
  }
  return propNames;
};


/**
 * Checks whether the property name specified should be disallowed.
 * @param {string} propName A property name.
 * @return {boolean} Whether the property name is disallowed.
 * @private
 */
goog.html.sanitizer.CssSanitizer.isDisallowedPropertyName_ = function(
    propName) {
  // getPropertyValue doesn't deal with custom variables properly and will NOT
  // decode CSS escapes (but the browser will do so silently). Simply disallow
  // custom variables (http://www.w3.org/TR/css-variables/#defining-variables).
  return goog.string.startsWith(propName, '--') ||
      goog.string.startsWith(propName, 'var');
};
