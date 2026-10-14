import { configure } from '@testing-library/dom';
import { installResizeObserver } from './test-support/resize-observer';

configure({ asyncUtilTimeout: 10_000 });
installResizeObserver();
