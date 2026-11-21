# Building NestJS Modules for StellarHunts

This guide follows the module conventions used in `backend/src/`. Keep feature
code colocated in `backend/src/<feature>/` and use TypeORM entities rather than
ad hoc database access.

## Module structure

A CRUD module normally contains:

- `<feature>.module.ts`: dependency wiring and providers.
- `<feature>.controller.ts`: HTTP routes and Swagger decorators.
- `<feature>.service.ts`: business logic and repository operations.
- `dto/*.dto.ts`: validated request/response shapes.
- `entities/*.entity.ts`: TypeORM persistence model.
- `*.spec.ts`: isolated unit tests.

## Complete CRUD example

The examples below belong together under `backend/src/hunt-badge/`.
They demonstrate the expected shapes only; adapt names and migrations for the
real schema.

`hunt-badge.entity.ts`

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('hunt_badges')
export class HuntBadge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
```

`dto/create-hunt-badge.dto.ts`

```ts
import { IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateHuntBadgeDto {
  @ApiProperty({ example: 'Soroban Explorer' })
  @IsString()
  @Length(1, 255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateHuntBadgeDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
```

`hunt-badge.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HuntBadge } from './hunt-badge.entity';
import { CreateHuntBadgeDto, UpdateHuntBadgeDto } from './dto/create-hunt-badge.dto';

@Injectable()
export class HuntBadgeService {
  constructor(
    @InjectRepository(HuntBadge)
    private readonly repository: Repository<HuntBadge>,
  ) {}

  create(dto: CreateHuntBadgeDto): Promise<HuntBadge> {
    return this.repository.save(this.repository.create(dto));
  }

  findAll(): Promise<HuntBadge[]> {
    return this.repository.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<HuntBadge> {
    const badge = await this.repository.findOne({ where: { id } });
    if (!badge) throw new NotFoundException('Hunt badge not found');
    return badge;
  }

  async update(id: string, dto: UpdateHuntBadgeDto): Promise<HuntBadge> {
    const badge = await this.findOne(id);
    Object.assign(badge, dto);
    return this.repository.save(badge);
  }

  async remove(id: string): Promise<void> {
    const badge = await this.findOne(id);
    await this.repository.remove(badge);
  }
}
```

`hunt-badge.controller.ts`

```ts
import {
  Body, Controller, Delete, Get, Param, Patch, Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HuntBadgeService } from './hunt-badge.service';
import { CreateHuntBadgeDto, UpdateHuntBadgeDto } from './dto/create-hunt-badge.dto';

@ApiTags('hunt-badges')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('hunt-badges')
export class HuntBadgeController {
  constructor(private readonly service: HuntBadgeService) {}

  @Post()
  create(@Body() dto: CreateHuntBadgeDto) {
    return this.service.create(dto);
  }

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateHuntBadgeDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
```

`hunt-badge.module.ts`

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HuntBadge } from './hunt-badge.entity';
import { HuntBadgeController } from './hunt-badge.controller';
import { HuntBadgeService } from './hunt-badge.service';

@Module({
  imports: [TypeOrmModule.forFeature([HuntBadge])],
  controllers: [HuntBadgeController],
  providers: [HuntBadgeService],
  exports: [HuntBadgeService],
})
export class HuntBadgeModule {}
```

Register the module in the application module, migration, and OpenAPI
generation flow. Route paths are automatically served below `/api/v1` by the
global prefix.

## TypeORM entity patterns

Use UUID primary keys for player-facing records, explicit column lengths, typed
enums for finite states, and `CreateDateColumn`/`UpdateDateColumn` for audit
timestamps. Mark nullable database values explicitly. Create a migration for
entity changes and keep entity and migration names synchronized.

Repository methods can use `findOne`, `save`, `create`, `remove`, and
`createQueryBuilder`. Add a single `NotFoundException` for missing rows and
authorization exceptions for ownership failures.

## Authentication and rate limiting

Place `JwtAuthGuard` on protected controllers or routes:

```ts
@UseGuards(JwtAuthGuard)
@Post()
create(@Body() dto: CreateHuntBadgeDto) {
  return this.service.create(dto);
}
```

For sensitive puzzle operations, use the existing `RateLimiterService` in a
guard or service:

```ts
const allowed = this.rateLimiter.isRateLimited(
  `hunt-badge:${playerId}`,
  60,
  10,
);
if (allowed) throw new HttpException('Too many requests', 429);
```

Use a stable key containing actor and resource identity. Fixed windows must
return `retryAfterSeconds` or an equivalent retry response.

## Testing pattern

Mock the repository and external services, construct the service directly, and
assert both the return value and repository calls. Use `jest.clearAllMocks()` in
`beforeEach`.

```ts
describe('HuntBadgeService', () => {
  const repository = {
    create: jest.fn((value) => value),
    save: jest.fn(),
    find: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('creates a hunt badge', async () => {
    repository.save.mockResolvedValue({ id: 'badge-1', name: 'Soroban' });
    const service = new HuntBadgeService(repository as any);
    await expect(
      service.create({ name: 'Soroban' }),
    ).resolves.toEqual({ id: 'badge-1', name: 'Soroban' });
  });
});
```
