//https://www.npmjs.com/package/opensubtitles-api

import OS  from 'opensubtitles-api';
const OpenSubtitles = new OS({
    useragent:'UserAgent',
    //username: 'Username',
    //password: 'Password',
    ssl: true
});
const subtitles = {};

export {
    subtitles,
}