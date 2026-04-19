import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function loadSchema(apiName: string) {
  const schemaPath = join(__dirname, '..', '..', 'strapi', 'src', 'api', apiName, 'content-types', apiName, 'schema.json');
  return JSON.parse(readFileSync(schemaPath, 'utf-8'));
}

describe('Content Type Schemas', () => {
  describe('Issue schema', () => {
    const schema = loadSchema('issue');

    it('should have required fields', () => {
      expect(schema.attributes.title).toBeDefined();
      expect(schema.attributes.title.required).toBe(true);
      expect(schema.attributes.description).toBeDefined();
      expect(schema.attributes.status).toBeDefined();
      expect(schema.attributes.priority).toBeDefined();
    });

    it('should have correct status enum values', () => {
      expect(schema.attributes.status.enum).toEqual([
        'open', 'confirmed', 'approved', 'in_progress', 'deploying', 'testing', 'staging', 'released', 'closed', 'reopen', 'on_hold', 'needs_info',
      ]);
    });

    it('should have correct priority enum values', () => {
      expect(schema.attributes.priority.enum).toEqual([
        'critical', 'high', 'medium', 'low', 'none',
      ]);
    });

    it('should have manyToOne relation to project', () => {
      expect(schema.attributes.project.type).toBe('relation');
      expect(schema.attributes.project.relation).toBe('manyToOne');
      expect(schema.attributes.project.target).toBe('api::project.project');
    });

    it('should have changeHistory json field', () => {
      expect(schema.attributes.changeHistory.type).toBe('json');
    });

    it('should have oneToMany relations to tasks and comments', () => {
      expect(schema.attributes.tasks.type).toBe('relation');
      expect(schema.attributes.tasks.relation).toBe('oneToMany');
      expect(schema.attributes.tasks.target).toBe('api::task.task');
      expect(schema.attributes.comments.type).toBe('relation');
      expect(schema.attributes.comments.relation).toBe('oneToMany');
      expect(schema.attributes.comments.target).toBe('api::comment.comment');
    });
  });

  describe('Task schema', () => {
    const schema = loadSchema('task');

    it('should have required fields', () => {
      expect(schema.attributes.title.required).toBe(true);
    });

    it('should have correct status enum', () => {
      expect(schema.attributes.status.enum).toEqual([
        'backlog', 'todo', 'in_progress', 'in_review', 'done',
      ]);
    });

    it('should have correct agentStatus enum', () => {
      expect(schema.attributes.agentStatus.enum).toEqual([
        'idle', 'running', 'completed', 'failed',
      ]);
    });

    it('should have manyToOne relation to issue', () => {
      expect(schema.attributes.issue.type).toBe('relation');
      expect(schema.attributes.issue.relation).toBe('manyToOne');
      expect(schema.attributes.issue.target).toBe('api::issue.issue');
    });
  });

  describe('Project schema', () => {
    const schema = loadSchema('project');

    it('should have required name field', () => {
      expect(schema.attributes.name.required).toBe(true);
    });

    it('should have correct defaultProvider enum', () => {
      expect(schema.attributes.defaultProvider.enum).toEqual([
        'anthropic', 'openai', 'gemini',
      ]);
    });

    it('should have relations to issues, tasks, chatSessions', () => {
      expect(schema.attributes.issues.target).toBe('api::issue.issue');
      expect(schema.attributes.tasks.target).toBe('api::task.task');
      expect(schema.attributes.chatSessions.target).toBe('api::chat-session.chat-session');
    });
  });

  describe('Comment schema', () => {
    const schema = loadSchema('comment');

    it('should have required body field', () => {
      expect(schema.attributes.body.required).toBe(true);
    });

    it('should have manyToOne relation to issue', () => {
      expect(schema.attributes.issue.type).toBe('relation');
      expect(schema.attributes.issue.relation).toBe('manyToOne');
      expect(schema.attributes.issue.target).toBe('api::issue.issue');
    });
  });

  describe('ChatSession schema', () => {
    const schema = loadSchema('chat-session');

    it('should have source enum', () => {
      expect(schema.attributes.source.enum).toEqual(['web', 'widget']);
    });

    it('should have relation to project', () => {
      expect(schema.attributes.project.type).toBe('relation');
      expect(schema.attributes.project.target).toBe('api::project.project');
    });
  });
});
