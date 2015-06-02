#!/usr/bin/env node
var _ = require('lodash')
var marked = require('marked')
var handlebars = require('handlebars')
var hljs = require('highlight.js')
var raml = require('raml-parser')
var path = require('path')
var fs = require('fs')
var pkg = require('../package.json')

var config = {
    version: pkg.version
}

var JSON_INDENT_SIZE = 2
function prettyJson(x) {
    return JSON.stringify(x, null, JSON_INDENT_SIZE)
}

// Try to pretty print a JSON string, falling back to the original if there's a
// parse error.
function tryPrettyJson(x) {
    try {
        return prettyJson(JSON.parse(x))
    } catch (e) {
        return x
    }
}

// Print error and exit 1 so we can break automated builds and such.
function die(message) {
    console.error(message)
    process.exit(1)
}

// Load file from templates/ directory.
function loadTemplate(x) {
    var f = path.join(__dirname, '..', 'templates', x)
    return fs.readFileSync(f, 'utf-8')
}

// Flatten RAML's nested hierarchy of traits and resources.
function flattenHierarchy(root) {
    var title = root.title
    var traits = traitsToObject(root.traits)
    var resources = flattenResources(root, root.traits)
    return {
        title: root.title,
        traits: traits,
        resources: resources
    }
}

// Convert traits from a list of objects to an object.
function traitsToObject(traits) {
    return _.reduce(traits, function(acc, obj) {
        var key = Object.keys(obj)[0]
        acc[key] = obj[key]
        return acc
    }, {})
}

// Flatten RAML's nested resources into a list of resources.
function flattenResources(res, traits) {
    var xs = []
    function recur(parents, res) {
        if (!res) {
            return
        }
        var clean = _.extend({}, res)
        delete clean.resources
        clean.methods = flattenMethods(res.methods)
        clean.basePath = _.pluck(parents, 'relativeUri').join('')
        clean.path = res.relativeUri
        xs.push(clean)
        var newParents = parents.concat([res])
        _.forEach(res.resources, function(r) {
            recur(newParents, r)
        })
    }
    recur([], res)
    return xs
}

// Generate example data for a data type.
function makeExampleFromType(t, name) {
    if (t === "string") {
        return "EXAMPLE: " + name
    } else if (t === "number") {
        return 1234567890
    }
    throw new Error("makeExampleFromType not implemented for type " + t)
}

// Flatten all the examples for a resource into a list, or generate a JSON body
// example based on the declared parameters, filling in junk data.
function makeExamplesOf(obj) {
    if (obj.body) {
        return _.map(_.pluck(_.values(obj.body), 'example'), tryPrettyJson)
    }
    var params = obj.params
    var obj = _.reduce(params, function(o, v) {
        var example = 'example' in v
            ? v.example
            : makeExampleFromType(v.type, v.displayName)
        _.set(o, v.displayName, example)
        return o
    }, {})
    return Object.keys(obj).length > 0
        ? [obj]
        : undefined
}

// Flattens the various methods defined on a resource, so we can have a list at
// the end, making it easy for the template.
function flattenMethods(methods) {
    return _.map(methods, function(objForMethod) {
        var obj = _.extend({}, objForMethod)
        var methodName = objForMethod.method
        obj.requestExamples = makeExamplesOf(obj)
        obj.responses = _.map(objForMethod.responses, function(objForCode, code) {
            var obj = {}
            _.forEach(objForCode, function(objForBody, body) {
                _.forEach(objForBody, function(objForRespType, respType) {
                    obj.example = objForRespType.example
                    obj.code = code
                    obj.method = methodName
                })
            })
            return obj
        })
        return obj
    })
}

// Load all Handlebars helpers and partials.
function registerHelpersAndPartials() {
    handlebars.registerHelper('json', function(data) {
        var out = hljs.highlight('json', prettyJson(data))
        return new handlebars.SafeString(
            '<pre class="hljs lang-json"><code>'
            + out.value
            + '</code></pre>'
        )
    })
    handlebars.registerHelper('response_code', function(num) {
        var n = Math.floor(num / 100)
        return new handlebars.SafeString(
            '<span class="response-code response-code-' + n + 'xx">'
            + handlebars.escapeExpression(num)
            + '</span>'
        )
    })
    handlebars.registerHelper('json_from_string', function(data) {
        if (data === undefined) {
            return ''
        }
        var err = ''
        try {
            data = prettyJson(JSON.parse(data))
        } catch (e) {
            err = JSON_PARSE_ERROR
        }
        var out = hljs.highlight('json', data)
        return new handlebars.SafeString(
            err
            + '<pre class="hljs lang-json"><code>'
            + out.value
            + '</code></pre>'
        )
    })
    handlebars.registerHelper('markdown', function(md) {
        return md ? new handlebars.SafeString(marked(md)) : ''
    })
    handlebars.registerHelper('upper_case', function(s) {
        return s.toUpperCase()
    })
    handlebars.registerPartial('resource', RESOURCE)
    handlebars.registerPartial('table_of_contents', TABLE_OF_CONTENTS)
    handlebars.registerPartial('style', STYLE)
}

// Curried form of tap for injecting side-effects into a pipeline.
function tap(f) {
    return function(o) {
        f(o)
        return o
    }
}

// Grab input RAML filename.
var args = process.argv.slice(2)
if (args.length !== 1) {
    die('Expected one argument: input RAML file')
}
var input = args[0]

// Load template files.
var INDEX = loadTemplate('index.handlebars')
var RESOURCE = loadTemplate('resource.handlebars')
var TABLE_OF_CONTENTS = loadTemplate('table_of_contents.handlebars')
var STYLE = loadTemplate('style.css')
var JSON_PARSE_ERROR = loadTemplate('invalid_json.html')
var toHtml = handlebars.compile(INDEX, {
    preventIndent: true
})

registerHelpersAndPartials()

function write(x) {
    process.stdout.write(x)
}

function parseFail(error) {
    die('Error parsing: ' + error)
}

// Ensure that uncaught exceptions are eventually shown in the console.
function throwLater(e) {
    setTimeout(function() { throw e }, 0)
}

// Load the RAML and output the HTML.
raml
    .loadFile(input)
    .catch(parseFail)
    .then(flattenHierarchy)
    .then(tap(function(obj) { obj.config = config }))
    .then(toHtml)
    .then(write)
    .catch(throwLater)
