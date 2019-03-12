'use strict';

var fs = require('fs');
var crypto = require('crypto');
var ConfigStore = require('configstore');
var xml2js = require('xml2js');
var xmlParser = new xml2js.Parser({explicitArray: false, ignoreAttrs: true});
var xmlBuilder = new xml2js.Builder();
var configStore;

function camSafeUrlEncode(str) {
    return encodeURIComponent(str)
        .replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\*/g, '%2A');
}

//测试用的key后面可以去掉
var getAuth = function (opt) {
    opt = opt || {};

    var SecretId = opt.SecretId;
    var SecretKey = opt.SecretKey;
    var method = (opt.method || opt.Method || 'get').toLowerCase();
    var queryParams = clone(opt.Query || opt.params || {});
    var headers = clone(opt.Headers || opt.headers || {});

    var Key = opt.Key || '';
    var pathname;
    if (opt.UseRawKey) {
        pathname = opt.Pathname || opt.pathname || '/' + Key;
    } else {
        pathname = opt.Pathname || opt.pathname || Key;
        pathname.indexOf('/') !== 0 && (pathname = '/' + pathname);
    }

    if (!SecretId) return console.error('missing param SecretId');
    if (!SecretKey) return console.error('missing param SecretKey');

    var getObjectKeys = function (obj) {
        var list = [];
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                list.push(key);
            }
        }
        return list.sort(function (a, b) {
            a = a.toLowerCase();
            b = b.toLowerCase();
            return a === b ? 0 : (a > b ? 1 : -1);
        });
    };

    var obj2str = function (obj) {
        var i, key, val;
        var list = [];
        var keyList = getObjectKeys(obj);
        for (i = 0; i < keyList.length; i++) {
            key = keyList[i];
            val = (obj[key] === undefined || obj[key] === null) ? '' : ('' + obj[key]);
            key = key.toLowerCase();
            key = camSafeUrlEncode(key);
            val = camSafeUrlEncode(val) || '';
            list.push(key + '=' + val)
        }
        return list.join('&');
    };

    // 签名有效起止时间
    var now = Math.round(getSkewTime(opt.SystemClockOffset) / 1000) - 1;
    var exp = now;

    var Expires = opt.Expires || opt.expires;
    if (Expires === undefined) {
        exp += 900; // 签名过期时间为当前 + 900s
    } else {
        exp += (Expires * 1) || 0;
    }

    // 要用到的 Authorization 参数列表
    var qSignAlgorithm = 'sha1';
    var qAk = SecretId;
    var qSignTime = now + ';' + exp;
    var qKeyTime = now + ';' + exp;
    var qHeaderList = getObjectKeys(headers).join(';').toLowerCase();
    var qUrlParamList = getObjectKeys(queryParams).join(';').toLowerCase();

    // 签名算法说明文档：https://www.qcloud.com/document/product/436/7778
    // 步骤一：计算 SignKey
    var signKey = crypto.createHmac('sha1', SecretKey).update(qKeyTime).digest('hex');

    // 步骤二：构成 FormatString
    var formatString = [method, pathname, obj2str(queryParams), obj2str(headers), ''].join('\n');
    formatString = Buffer.from(formatString, 'utf8');

    // 步骤三：计算 StringToSign
    var res = crypto.createHash('sha1').update(formatString).digest('hex');
    var stringToSign = ['sha1', qSignTime, res, ''].join('\n');

    // 步骤四：计算 Signature
    var qSignature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');

    // 步骤五：构造 Authorization
    var authorization = [
        'q-sign-algorithm=' + qSignAlgorithm,
        'q-ak=' + qAk,
        'q-sign-time=' + qSignTime,
        'q-key-time=' + qKeyTime,
        'q-header-list=' + qHeaderList,
        'q-url-param-list=' + qUrlParamList,
        'q-signature=' + qSignature
    ].join('&');

    return authorization;

};

var getV4Auth = function (opt) {

    if (!opt.SecretId) return console.error('missing param SecretId');
    if (!opt.SecretKey) return console.error('missing param SecretKey');
    if (!opt.Bucket) return console.error('missing param Bucket');

    var longBucket = opt.Bucket;
    var ShortBucket = longBucket.substr(0, longBucket.lastIndexOf('-'));
    var AppId = longBucket.substr(longBucket.lastIndexOf('-') + 1);
    var random = Math.round(Math.random() * Math.pow(2, 32));
    var now = Math.round(Date.now() / 1000);
    var e = now + (opt.Expires === undefined ? 900 : opt.Expires);
    var path = '/' + AppId + '/' + ShortBucket + '/' + encodeURIComponent((opt.Key || '').replace(/(^\/*)/g, '')).replace(/%2F/g, '/');
    var plainText = 'a=' + AppId + '&b=' + ShortBucket + '&k=' + opt.SecretId + '&t=' + now + '&e=' + e + '&r=' + random + '&f=' + path;
    var signKey = crypto.createHmac("sha1", opt.SecretKey).update(plainText).digest();
    var sign = Buffer.concat([signKey, Buffer.from(plainText)]).toString("base64");
    return sign;
};

var noop = function () {

};

// 清除对象里值为的 undefined 或 null 的属性
var clearKey = function (obj) {
    var retObj = {};
    for (var key in obj) {
        if (obj.hasOwnProperty(key) && obj[key] !== undefined && obj[key] !== null) {
            retObj[key] = obj[key];
        }
    }
    return retObj;
};

// XML 对象转 JSON 对象
var xml2json = function (bodyStr) {
    var d = {};
    xmlParser.parseString(bodyStr, function (err, result) {
        d = result;
    });

    return d;
};

// JSON 对象转 XML 对象
var json2xml = function (json) {
    var xml = xmlBuilder.buildObject(json);
    return xml;
};

// 计算 MD5
var md5 = function (str, encoding) {
    return crypto.createHash('md5').update(str).digest(encoding || 'hex');
};

// 获取文件 md5 值
var getFileMd5 = function (readStream, callback) {
    var md5 = crypto.createHash('md5');
    readStream.on('data', function (chunk) {
        md5.update(chunk);
    });
    readStream.on('error', function (err) {
        callback(err);
    });
    readStream.on('end', function () {
        var hash = md5.digest('hex');
        callback(null, hash);
    });
};

function clone(obj) {
    return map(obj, function (v) {
        return typeof v === 'object' ? clone(v) : v;
    });
}

function extend(target, source) {
    each(source, function (val, key) {
        target[key] = source[key];
    });
    return target;
}

function isArray(arr) {
    return arr instanceof Array;
}

function isInArray(arr, item) {
    var flag = false;
    for (var i = 0; i < arr.length; i++) {
        if (item === arr[i]) {
            flag = true;
            break;
        }
    }
    return flag;
}

function each(obj, fn) {
    for (var i in obj) {
        if (obj.hasOwnProperty(i)) {
            fn(obj[i], i);
        }
    }
}

function map(obj, fn) {
    var o = isArray(obj) ? [] : {};
    for (var i in obj) {
        if (obj.hasOwnProperty(i)) {
            o[i] = fn(obj[i], i);
        }
    }
    return o;
}

function filter(obj, fn) {
    var iaArr = isArray(obj);
    var o = iaArr ? [] : {};
    for (var i in obj) {
        if (obj.hasOwnProperty(i)) {
            if (fn(obj[i], i)) {
                if (iaArr) {
                    o.push(obj[i]);
                } else {
                    o[i] = obj[i];
                }
            }
        }
    }
    return o;
}

var binaryBase64 = function (str) {
    var i, len, char, arr = [];
    for (i = 0, len = str.length / 2; i < len; i++) {
        char = parseInt(str[i * 2] + str[i * 2 + 1], 16);
        arr.push(char);
    }
    return Buffer.from(arr).toString('base64');
};
var uuid = function () {
    var S4 = function () {
        return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
    };
    return (S4() + S4() + "-" + S4() + "-" + S4() + "-" + S4() + "-" + S4() + S4() + S4());
};

var hasMissingParams = function (apiName, params) {
    var Bucket = params.Bucket;
    var Region = params.Region;
    var Key = params.Key;
    if (apiName.indexOf('Bucket') > -1 || apiName === 'deleteMultipleObject' || apiName === 'multipartList' || apiName === 'listObjectVersions') {
        if (!Bucket) return 'Bucket';
        if (!Region) return 'Region';
    } else if (apiName.indexOf('Object') > -1 || apiName.indexOf('multipart') > -1 || apiName === 'sliceUploadFile' || apiName === 'abortUploadTask') {
        if (!Bucket) return 'Bucket';
        if (!Region) return 'Region';
        if (!Key) return 'Key';
    }
    return false;
};

var formatParams = function (apiName, params) {

    // 复制参数对象
    params = extend({}, params);

    // 统一处理 Headers
    if (apiName !== 'getAuth' && apiName !== 'getV4Auth' && apiName !== 'getObjectUrl') {
        var Headers = params.Headers || {};
        if (params && typeof params === 'object') {
            (function () {
                for (var key in params) {
                    if (params.hasOwnProperty(key) && key.indexOf('x-cos-') > -1) {
                        Headers[key] = params[key];
                    }
                }
            })();

            var headerMap = {
                // params headers
                'x-cos-mfa': 'MFA',
                'Content-MD5': 'ContentMD5',
                'Content-Length': 'ContentLength',
                'Content-Type': 'ContentType',
                'Expect': 'Expect',
                'Expires': 'Expires',
                'Cache-Control': 'CacheControl',
                'Content-Disposition': 'ContentDisposition',
                'Content-Encoding': 'ContentEncoding',
                'Range': 'Range',
                'If-Modified-Since': 'IfModifiedSince',
                'If-Unmodified-Since': 'IfUnmodifiedSince',
                'If-Match': 'IfMatch',
                'If-None-Match': 'IfNoneMatch',
                'x-cos-copy-source': 'CopySource',
                'x-cos-copy-source-Range': 'CopySourceRange',
                'x-cos-metadata-directive': 'MetadataDirective',
                'x-cos-copy-source-If-Modified-Since': 'CopySourceIfModifiedSince',
                'x-cos-copy-source-If-Unmodified-Since': 'CopySourceIfUnmodifiedSince',
                'x-cos-copy-source-If-Match': 'CopySourceIfMatch',
                'x-cos-copy-source-If-None-Match': 'CopySourceIfNoneMatch',
                'x-cos-acl': 'ACL',
                'x-cos-grant-read': 'GrantRead',
                'x-cos-grant-write': 'GrantWrite',
                'x-cos-grant-full-control': 'GrantFullControl',
                'x-cos-grant-read-acp': 'GrantReadAcp',
                'x-cos-grant-write-acp': 'GrantWriteAcp',
                'x-cos-storage-class': 'StorageClass',
                // SSE-C
                'x-cos-server-side-encryption-customer-algorithm': 'SSECustomerAlgorithm',
                'x-cos-server-side-encryption-customer-key': 'SSECustomerKey',
                'x-cos-server-side-encryption-customer-key-MD5': 'SSECustomerKeyMD5',
                // SSE-COS、SSE-KMS
                'x-cos-server-side-encryption': 'ServerSideEncryption',
                'x-cos-server-side-encryption-cos-kms-key-id': 'SSEKMSKeyId',
                'x-cos-server-side-encryption-context': 'SSEContext',
            };
            util.each(headerMap, function (paramKey, headerKey) {
                if (params[paramKey] !== undefined) {
                    Headers[headerKey] = params[paramKey];
                }
            });

            params.Headers = clearKey(Headers);
        }
    }

    return params;
};

var apiWrapper = function (apiName, apiFn) {
    return function (params, callback) {

        // 处理参数
        if (typeof params === 'function') {
            callback = params;
            params = {};
        }

        // 整理参数格式
        params = formatParams(apiName, params);

        // 代理回调函数
        var formatResult = function (result) {
            if (result && result.headers) {
                result.headers['x-cos-version-id'] && (result.VersionId = result.headers['x-cos-version-id']);
                result.headers['x-cos-delete-marker'] && (result.DeleteMarker = result.headers['x-cos-delete-marker']);
            }
            return result;
        };
        var _callback = function (err, data) {
            callback && callback(formatResult(err), formatResult(data));
        };

        if (apiName !== 'getService' && apiName !== 'abortUploadTask') {
            // 判断参数是否完整
            var missingResult;
            if (missingResult = hasMissingParams(apiName, params)) {
                _callback({error: 'missing param ' + missingResult});
                return;
            }
            // 判断 region 格式
            if (params.Region) {
                if (params.Region.indexOf('cos.') > -1) {
                    _callback({error: 'param Region should not be start with "cos."'});
                    return;
                } else if (!/^([a-z\d-]+)$/.test(params.Region)) {
                    _callback({error: 'Region format error.'});
                    return;
                }
                // 判断 region 格式
                if (!this.options.CompatibilityMode && params.Region.indexOf('-') === -1 && params.Region !== 'yfb' && params.Region !== 'default') {
                    console.warn('warning: param Region format error, find help here: https://cloud.tencent.com/document/product/436/6224');
                }
            }
            // 兼容不带 AppId 的 Bucket
            if (params.Bucket) {
                if (!/^([a-z\d-]+)-(\d+)$/.test(params.Bucket)) {
                    if (params.AppId) {
                        params.Bucket = params.Bucket + '-' + params.AppId;
                    } else if (this.options.AppId) {
                        params.Bucket = params.Bucket + '-' + this.options.AppId;
                    } else {
                        _callback({error: 'Bucket should format as "test-1250000000".'});
                        return;
                    }
                }
                if (params.AppId) {
                    console.warn('warning: AppId has been deprecated, Please put it at the end of parameter Bucket(E.g Bucket:"test-1250000000" ).');
                    delete params.AppId;
                }
            }
            // 如果 Key 是 / 开头，强制去掉第一个 /
            if (!this.options.UseRawKey && params.Key && params.Key.substr(0, 1) === '/') {
                params.Key = params.Key.substr(1);
            }
        }
        var res = apiFn.call(this, params, _callback);
        if (apiName === 'getAuth' || apiName === 'getV4Auth' || apiName === 'getObjectUrl') {
            return res;
        }
    }
};

var throttleOnProgress = function (total, onProgress) {
    var self = this;
    var size0 = 0;
    var size1 = 0;
    var time0 = Date.now();
    var time1;
    var timer;

    function update() {
        timer = 0;
        if (onProgress && (typeof onProgress === 'function')) {
            time1 = Date.now();
            var speed = Math.max(0, Math.round((size1 - size0) / ((time1 - time0) / 1000) * 100) / 100);
            var percent;
            if (size1 === 0 && total === 0) {
                percent = 1;
            } else {
                percent = Math.round(size1 / total * 100) / 100 || 0;
            }
            time0 = time1;
            size0 = size1;
            try {
                onProgress({loaded: size1, total: total, speed: speed, percent: percent});
            } catch (e) {
            }
        }
    }

    return function (info, immediately) {
        if (info) {
            size1 = info.loaded;
            total = info.total;
        }
        if (immediately) {
            clearTimeout(timer);
            update();
        } else {
            if (timer) return;
            timer = setTimeout(update, self.options.ProgressInterval);
        }
    };
};

var getFileSize = function (api, params, callback) {
    var size;
    if (api === 'sliceUploadFile') {
        if (params.FilePath) {
            fs.stat(params.FilePath, function (err, fileStats) {
                if (err) {
                    if (params.ContentLength !== undefined) {
                        size = params.ContentLength;
                    } else {
                        callback(err);
                        return;
                    }
                } else {
                    params.FileStat = fileStats;
                    params.FileStat.FilePath = params.FilePath;
                    size = fileStats.isDirectory() ? 0 : fileStats.size;
                }
                params.ContentLength = size = size || 0;
                callback(null, size);
            });
            return;
        } else {
            callback({error: 'missing param FilePath'});
            return;
        }
    } else {
        if (params.Body !== undefined) {
            if (typeof params.Body === 'string') {
                params.Body = global.Buffer.from(params.Body);
            }
            if (params.Body instanceof global.Buffer) {
                size = params.Body.length;
            } else if (typeof params.Body.pipe === 'function') {
                if (params.ContentLength === undefined) {
                    size = undefined;
                } else {
                    size = params.ContentLength;
                }
            } else {
                callback({error: 'params Body format error, Only allow Buffer|Stream|String.'});
                return;
            }
        } else {
            callback({error: 'missing param Body'});
            return;
        }
    }
    params.ContentLength = size;
    callback(null, size);
};

var getSkewTime = function (offset) {
    return Date.now() + (offset || 0);
};

var util = {
    noop: noop,
    formatParams: formatParams,
    apiWrapper: apiWrapper,
    xml2json: xml2json,
    json2xml: json2xml,
    md5: md5,
    clearKey: clearKey,
    getFileMd5: getFileMd5,
    binaryBase64: binaryBase64,
    extend: extend,
    isArray: isArray,
    isInArray: isInArray,
    each: each,
    map: map,
    filter: filter,
    clone: clone,
    uuid: uuid,
    camSafeUrlEncode: camSafeUrlEncode,
    throttleOnProgress: throttleOnProgress,
    getFileSize: getFileSize,
    getSkewTime: getSkewTime,
    getAuth: getAuth,
    getV4Auth: getV4Auth,
    isBrowser: false,
};

(function () {
    try {
        configStore = new ConfigStore('cos-nodejs-sdk-v5-storage');
    } catch (e) {
    }
    var map = {};
    var update = function (key, val) {
        if (map.hasOwnProperty(key)) {
            map[key] = val;
        } else {
            map[key] = val;
            setTimeout(function () {
                if (!configStore) return;
                if (map[key] === undefined) {
                    configStore.delete(key);
                } else {
                    configStore.set(key, map[key]);
                }
                delete map[key];
            }, 300);
        }
    };
    util.localStorage = {
        getItem: function (key) {
            return configStore && configStore.get(key);
        },
        setItem: update,
        removeItem: update,
    };
})();
util.fileSlice = function (FilePath, start, end, callback) {
    if (FilePath) {
        callback(fs.createReadStream(FilePath, {start: start, end: end - 1}));
    } else {
        callback(null);
    }
};
util.getFileUUID = function (FileStat, ChunkSize) {
    if (FileStat && FileStat.FilePath && FileStat.size && FileStat.ctime && FileStat.mtime && ChunkSize) {
        return util.md5([FileStat.FilePath].join('::')) + '-' + util.md5([FileStat.size, FileStat.ctime, FileStat.mtime, ChunkSize].join('::'));
    } else {
        return null;
    }
};
util.getBodyMd5 = function (UploadCheckContentMd5, Body, callback) {
    callback = callback || noop;
    if (UploadCheckContentMd5) {
        if (Body instanceof Buffer || typeof Body === 'string') {
            callback(util.md5(Body));
        } else {
            callback();
        }
    } else {
        callback();
    }
};

module.exports = util;
