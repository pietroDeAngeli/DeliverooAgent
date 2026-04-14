declare module '@unitn-asa/deliveroo-js-sdk/client' {
    // Tell TS that this module exports a function called DjsConnect
    // which takes two strings and returns an 'any' object (the socket)
    export function DjsConnect(url: string, token: string): any;
}