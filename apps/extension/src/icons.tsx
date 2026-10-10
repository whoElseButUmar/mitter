import type { JSX } from 'solid-js';
export function Mark(props:{size?:number}) {return <svg width={props.size??30} height={props.size??30} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M5 30V9l15 13L35 9v21h-7V24l-8 7-8-7v6H5Z" fill="currentColor"/></svg>;}
const paths:Record<string,string>={
 history:'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v6l4 2',
 file:'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6',
 plus:'M12 5v14M5 12h14', play:'m8 5 11 7-11 7V5Z', pause:'M8 5v14M16 5v14', close:'m6 6 12 12M18 6 6 18',
 arrow:'M5 12h14m-6-6 6 6-6 6', copy:'M9 9h11v11H9zM4 15V4h11', folder:'M3 7V5h6l2 2h10v12H3V7Z',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
 terminal:'m5 7 5 5-5 5M13 17h6', check:'m5 12 4 4L19 6', shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z',
 undo:'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12', expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
 down:'m6 9 6 6 6-6', bolt:'m13 2-8 12h6l-1 8 9-13h-6l1-7Z', link:'m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 8a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2',
};
export function Icon(props:{name:string;size?:number;class?:string}):JSX.Element{return <svg class={props.class} width={props.size??18} height={props.size??18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[props.name]??paths.arrow}/></svg>;}
