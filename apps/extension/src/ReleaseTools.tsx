import {onMount,onCleanup} from 'solid-js';
import {mountHealthPanel,type HealthPanelOptions} from '../../../packages/ui/src/health-panel';
import {mountChangeReview,type ChangeReviewOptions} from '../../../packages/ui/src/change-review';
export function HealthPanel(props:HealthPanelOptions){let root!:HTMLDivElement;onMount(()=>{const panel=mountHealthPanel(root,props);onCleanup(panel.dispose);});return <div class="health-panel" ref={root}/>;}
export function ChangeReview(props:ChangeReviewOptions){let root!:HTMLDivElement;onMount(()=>{const panel=mountChangeReview(root,props);onCleanup(panel.dispose);});return <div class="change-review" ref={root}/>;}
