import {ResetBoundary} from '../../src/ResetBoundary';
import { render } from 'solid-js/web';
import App from '../../src/App';
render(() => <ResetBoundary app={()=><App/>}/>, document.getElementById('root')!);
