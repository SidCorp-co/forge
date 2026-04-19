export const clientLogos = [
  {
    name: 'CDP',
    color: '#f59e0b',
    path: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  },
  {
    name: 'Teamix',
    color: '#4A90D9',
    path: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  },
  {
    name: 'Helpdesk',
    color: '#2ECC71',
    path: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z',
  },
  {
    name: 'DodgePrint',
    color: '#9B59B6',
    path: 'M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6-2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2zm6 16H6V8h2v2c0 .55.45 1 1 1s1-.45 1-1V8h4v2c0 .55.45 1 1 1s1-.45 1-1V8h2v12z',
  },
  {
    name: 'AnHome',
    color: '#E67E22',
    path: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  },
];

export interface DeliveryMetric {
  value: number;
  label: string;
  suffix?: string;
  bar: number;
}

export const deliveryMetrics: DeliveryMetric[] = [
  { value: 5, label: 'Products Live', bar: 100 },
  { value: 14, label: 'Avg Days to MVP', suffix: 'days', bar: 47 },
  { value: 6, label: 'Domains Covered', bar: 80 },
  { value: 95, label: 'Client Retention', suffix: '%', bar: 95 },
];

export const teamMembers = [
  { name: 'Alex Chen', role: 'Lead Engineer', gradient: 'from-amber-400 to-orange-500' },
  { name: 'Sarah Kim', role: 'Full-Stack Dev', gradient: 'from-blue-400 to-cyan-500' },
  { name: 'Marcus Rivera', role: 'AI/ML Engineer', gradient: 'from-purple-400 to-pink-500' },
  { name: 'Priya Patel', role: 'Mobile Dev', gradient: 'from-green-400 to-emerald-500' },
  { name: 'Jordan Lee', role: 'Cloud Architect', gradient: 'from-red-400 to-rose-500' },
  { name: 'Noa Tanaka', role: 'UI Designer', gradient: 'from-indigo-400 to-violet-500' },
];

export const teamCapability = 'Full-stack, AI/ML, mobile, cloud infra';
export const teamCount = '12 engineers, 3 designers';

export const videoConfig = {
  embedUrl: '',
  posterGradient: 'from-surface-container-low to-surface-container',
};

export const showcaseDomains = ['All', 'CRM & Marketing', 'HR & Operations', 'Customer Support', 'E-commerce', 'Property Management'] as const;

export interface ShowcaseProject {
  title: string;
  domain: string;
  problem: string;
  solution: string;
  result: string;
  techStack: string[];
  timelineDays: number;
  demoUrl?: string;
  videoUrl?: string;
  thumbnail: string;
}

export const showcaseProjects: ShowcaseProject[] = [];

export const coveredDomains = [
  { name: 'CRM & Marketing', icon: 'Users' },
  { name: 'HR & Operations', icon: 'Briefcase' },
  { name: 'Customer Support', icon: 'MessageCircle' },
  { name: 'E-commerce & Fulfillment', icon: 'ShoppingCart' },
  { name: 'Property Management', icon: 'Home' },
  { name: 'AI & Automation', icon: 'Cpu' },
];
